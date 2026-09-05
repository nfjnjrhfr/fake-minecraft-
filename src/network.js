// The packet layer: nodes (routers and hosts), links, routing and delivery.

import { Clock, drive } from './clock.js';
import { makeRng } from './rng.js';

let packetCounter = 0;

export class Packet {
  constructor({ src, dst, proto, payload = null, ttl = 32, id = null, port = null, replyPort = null }) {
    this.src = src;
    this.dst = dst;
    this.proto = proto; // 'echo' | 'icmp' | 'req' | 'res'
    this.payload = payload;
    this.ttl = ttl;
    this.id = id ?? `p${++packetCounter}`;
    this.port = port;
    this.replyPort = replyPort;
    this.hops = [];
    this.bornAt = null;
  }
}

export class Link {
  constructor(a, b, { latency = 10, loss = 0, label = '' } = {}) {
    this.a = a;
    this.b = b;
    this.latency = latency;
    this.loss = loss;
    this.label = label;
  }

  other(name) {
    return this.a === name ? this.b : this.a;
  }
}

export class Node {
  constructor(net, { name, ip, kind = 'router', location = '' }) {
    this.net = net;
    this.name = name;
    this.ip = ip;
    this.kind = kind;
    this.location = location;
    this.routes = new Map(); // destination ip -> next hop node name
    this.pending = new Map(); // packet id -> { resolve, timer }
    this.stats = { forwarded: 0, received: 0, dropped: 0 };
  }

  get clock() {
    return this.net.clock;
  }

  /** Put a packet on the wire, starting at this node. */
  emit(packet) {
    packet.bornAt = this.clock.now;
    packet.origin ??= this.name;
    this.net.deliver(this.name, packet);
  }

  /** Wait for a packet whose id matches, or resolve to null on timeout. */
  awaitReply(id, timeout) {
    return new Promise((resolve) => {
      const timer = this.clock.after(timeout, () => {
        if (this.pending.get(id)) {
          this.pending.delete(id);
          resolve(null);
        }
      });
      this.pending.set(id, { resolve, timer });
    });
  }

  settle(id, value) {
    const waiter = this.pending.get(id);
    if (!waiter) return false;
    this.pending.delete(id);
    Clock.cancel(waiter.timer);
    waiter.resolve(value);
    return true;
  }

  receive(packet) {
    this.stats.received++;
    switch (packet.proto) {
      case 'echo':
        this.emit(
          new Packet({
            src: this.ip,
            dst: packet.src,
            proto: 'icmp',
            id: packet.id,
            payload: { type: 'echo-reply', from: this.name },
          }),
        );
        return;
      case 'icmp':
      case 'res':
        this.settle(packet.id, packet);
        return;
      default:
        // Routers speak nothing else; a host overrides this.
        this.emit(
          new Packet({
            src: this.ip,
            dst: packet.src,
            proto: 'icmp',
            id: packet.id,
            payload: { type: 'port-unreachable', from: this.name },
          }),
        );
    }
  }

  /** ICMP-style ping. Returns { rtt, from } or null when it times out. */
  async ping(dstIp, { timeout = 2000, ttl = 32 } = {}) {
    const probe = new Packet({ src: this.ip, dst: dstIp, proto: 'echo', ttl });
    const started = this.clock.now;
    const reply = this.awaitReply(probe.id, timeout);
    this.emit(probe);
    return this.finishPing(await reply, started);
  }

  finishPing(reply, started) {
    if (!reply) return null;
    return { rtt: this.clock.now - started, from: reply.src, type: reply.payload?.type ?? 'echo-reply' };
  }

  /** Increasing-TTL probes, exactly like the real thing. */
  async traceroute(dstIp, { maxHops = 20, timeout = 2000 } = {}) {
    const hops = [];
    for (let ttl = 1; ttl <= maxHops; ttl++) {
      const reply = await this.ping(dstIp, { ttl, timeout });
      if (!reply) {
        hops.push({ ttl, ip: null, name: '*', rtt: null });
        continue;
      }
      const node = this.net.byIp(reply.from);
      hops.push({ ttl, ip: reply.from, name: node ? node.name : reply.from, rtt: reply.rtt });
      if (reply.type === 'echo-reply') break;
    }
    return hops;
  }
}

export class Internet {
  constructor({ seed = 20260905, jitter = 0.12 } = {}) {
    this.clock = new Clock();
    this.jitter = jitter;
    this.rng = makeRng(seed);
    this.nodes = new Map();
    this.links = [];
    this.hostnames = new Map(); // hostname -> ip
    this.stats = { emitted: 0, forwarded: 0, lost: 0, expired: 0, unreachable: 0 };
    this.hostBytes = new Map();
    this.log = [];
    this.logging = false;
  }

  addNode(node) {
    if (this.nodes.has(node.name)) throw new Error(`duplicate node ${node.name}`);
    this.nodes.set(node.name, node);
    return node;
  }

  addRouter(name, ip, { location = '' } = {}) {
    return this.addNode(new Node(this, { name, ip, kind: 'router', location }));
  }

  link(a, b, options = {}) {
    if (!this.nodes.has(a)) throw new Error(`unknown node ${a}`);
    if (!this.nodes.has(b)) throw new Error(`unknown node ${b}`);
    const link = new Link(a, b, options);
    this.links.push(link);
    return link;
  }

  linksOf(name) {
    return this.links.filter((l) => l.a === name || l.b === name);
  }

  linkBetween(a, b) {
    return this.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  }

  byIp(ip) {
    for (const node of this.nodes.values()) if (node.ip === ip) return node;
    return null;
  }

  register(hostname, ip) {
    this.hostnames.set(hostname, ip);
  }

  /** Dijkstra over link latency; every node ends up with a full next-hop table. */
  computeRoutes() {
    const names = [...this.nodes.keys()];
    for (const src of names) {
      const dist = new Map(names.map((n) => [n, Infinity]));
      const prev = new Map();
      const visited = new Set();
      dist.set(src, 0);

      for (;;) {
        let current = null;
        let best = Infinity;
        for (const name of names) {
          if (!visited.has(name) && dist.get(name) < best) {
            best = dist.get(name);
            current = name;
          }
        }
        if (current === null) break;
        visited.add(current);
        for (const link of this.linksOf(current)) {
          const neighbour = link.other(current);
          const candidate = dist.get(current) + link.latency;
          if (candidate < dist.get(neighbour)) {
            dist.set(neighbour, candidate);
            prev.set(neighbour, current);
          }
        }
      }

      const node = this.nodes.get(src);
      node.routes.clear();
      for (const dest of names) {
        if (dest === src || dist.get(dest) === Infinity) continue;
        let step = dest;
        while (prev.get(step) !== src) step = prev.get(step);
        node.routes.set(this.nodes.get(dest).ip, step);
      }
    }
  }

  trace(entry) {
    if (this.logging) this.log.push({ time: this.clock.now, ...entry });
  }

  /** One hop of packet processing, at `nodeName`. */
  deliver(nodeName, packet) {
    const node = this.nodes.get(nodeName);
    if (!node) return;

    if (node.ip === packet.dst) {
      this.trace({ event: 'receive', at: node.name, proto: packet.proto, id: packet.id });
      node.receive(packet);
      return;
    }

    const nextHop = node.routes.get(packet.dst);
    if (!nextHop) {
      this.stats.unreachable++;
      node.stats.dropped++;
      this.trace({ event: 'unreachable', at: node.name, dst: packet.dst });
      this.icmp(node, packet, 'destination-unreachable');
      return;
    }

    packet.hops.push(node.name);
    if (node.name !== packet.origin) packet.ttl--;
    if (packet.ttl <= 0) {
      this.stats.expired++;
      node.stats.dropped++;
      this.trace({ event: 'ttl-exceeded', at: node.name, id: packet.id });
      this.icmp(node, packet, 'ttl-exceeded');
      return;
    }

    const link = this.linkBetween(node.name, nextHop);
    if (this.rng() < link.loss) {
      this.stats.lost++;
      node.stats.dropped++;
      this.trace({ event: 'lost', at: node.name, to: nextHop, id: packet.id });
      return;
    }

    const jitter = 1 + (this.rng() * 2 - 1) * this.jitter;
    const latency = Math.max(1, Math.round(link.latency * jitter));
    this.stats.forwarded++;
    node.stats.forwarded++;
    this.trace({ event: 'forward', at: node.name, to: nextHop, id: packet.id, latency });
    this.clock.after(latency, () => this.deliver(nextHop, packet));
  }

  icmp(node, packet, type) {
    if (packet.proto === 'icmp') return; // never answer an error with an error
    node.emit(
      new Packet({
        src: node.ip,
        dst: packet.src,
        proto: 'icmp',
        id: packet.id,
        payload: { type, from: node.name },
      }),
    );
  }

  /** Run the simulation until `promise` settles. */
  settle(promise) {
    return drive(this.clock, promise);
  }

  allocateIp(prefix) {
    const next = (this.hostBytes.get(prefix) ?? 9) + 1;
    if (next > 254) throw new Error(`subnet ${prefix}.0/24 is full`);
    this.hostBytes.set(prefix, next);
    return `${prefix}.${next}`;
  }
}
