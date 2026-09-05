// Hosts: the machines at the edge of the network. They speak a tiny
// request/response protocol on top of the packet layer, plus DNS and HTTP.

import { Node, Packet } from './network.js';
import { parseUrl } from './url.js';

export class NetworkError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'NetworkError';
    this.reason = reason;
  }
}

export class Host extends Node {
  constructor(net, options) {
    super(net, { ...options, kind: 'host' });
    this.ports = new Map();
    this.dnsIp = options.dnsIp ?? null;
    this.dnsCache = new Map();
    this.transfers = { requests: 0, retries: 0, failures: 0 };
  }

  listen(port, handler) {
    this.ports.set(port, handler);
    return this;
  }

  receive(packet) {
    if (packet.proto !== 'req') {
      super.receive(packet);
      return;
    }

    this.stats.received++;
    const handler = this.ports.get(packet.port);
    const reply = (payload) =>
      this.emit(
        new Packet({ src: this.ip, dst: packet.src, proto: 'res', id: packet.id, payload }),
      );

    if (!handler) {
      reply({ error: 'connection refused', port: packet.port });
      return;
    }

    Promise.resolve()
      .then(() => handler(packet.payload, { from: packet.src, port: packet.port }))
      .then(reply, (error) => reply({ error: String(error?.message ?? error) }));
  }

  /**
   * Send a request and wait for the response, retrying through packet loss.
   * Each attempt is a fresh packet, so a lost request and a lost reply both
   * recover the same way.
   */
  async request(dstIp, port, payload, { timeout = 1200, retries = 4 } = {}) {
    this.transfers.requests++;
    let reason = 'timeout';

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) this.transfers.retries++;
      const packet = new Packet({ src: this.ip, dst: dstIp, proto: 'req', port, payload });
      const pending = this.awaitReply(packet.id, timeout);
      this.emit(packet);
      const response = await pending;

      if (response?.proto === 'res') return response.payload;
      if (response?.proto === 'icmp') {
        reason = response.payload?.type ?? 'icmp';
        if (reason === 'destination-unreachable') break; // routing, not luck: don't retry
      }
    }

    this.transfers.failures++;
    throw new NetworkError(`${dstIp}:${port} did not answer (${reason})`, reason);
  }

  /** Ask the configured resolver for a hostname, with a local cache. */
  async resolve(hostname) {
    const name = hostname.toLowerCase();
    if (this.dnsCache.has(name)) return this.dnsCache.get(name);
    if (!this.dnsIp) throw new NetworkError(`${this.name} has no resolver configured`, 'no-resolver');

    const answer = await this.request(this.dnsIp, 53, { name }, { timeout: 800, retries: 4 });
    if (!answer || !answer.ip) throw new NetworkError(`cannot resolve ${hostname}`, 'nxdomain');
    this.dnsCache.set(name, answer.ip);
    return answer.ip;
  }

  /** HTTP-ish GET/POST. Returns { status, headers, body, url, ip, ms }. */
  async fetch(url, { method = 'GET', body = null, timeout = 1500, retries = 4 } = {}) {
    const target = parseUrl(url);
    const ip = await this.resolve(target.hostname);
    const started = this.clock.now;
    const response = await this.request(
      ip,
      target.port,
      { method, path: target.path, host: target.hostname, query: target.query, body },
      { timeout, retries },
    );

    if (response?.error) throw new NetworkError(`${target.hostname}: ${response.error}`, 'refused');
    return {
      ...response,
      url: target.href,
      hostname: target.hostname,
      ip,
      ms: this.clock.now - started,
    };
  }
}

/** A DNS server: the only machine allowed to read the global name table. */
export function createResolver(net, host, { extra = {} } = {}) {
  host.listen(53, ({ name }) => {
    const key = String(name ?? '').toLowerCase();
    const ip = extra[key] ?? net.hostnames.get(key) ?? null;
    return { name: key, ip, authority: host.name };
  });
  return host;
}
