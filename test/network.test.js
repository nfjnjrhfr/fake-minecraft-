import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld } from '../src/world.js';
import { NetworkError } from '../src/host.js';

const perfectWorld = () => createWorld({ lossScale: 0, jitter: 0 });

test('every node can route to every other node', () => {
  const { net } = perfectWorld();
  const ips = [...net.nodes.values()].map((node) => node.ip);
  for (const node of net.nodes.values()) {
    for (const ip of ips) {
      if (ip === node.ip) continue;
      assert.ok(node.routes.has(ip), `${node.name} has no route to ${ip}`);
    }
  }
});

test('ping measures a round trip that matches the path latency', async () => {
  const { net, laptop } = perfectWorld();
  const wikiIp = net.hostnames.get('wiki.mine.net');
  const reply = await net.settle(laptop.ping(wikiIp));

  assert.equal(reply.from, wikiIp);
  // laptop 4 + isp-taipei 12 + core-asia 62 + core-eu 5 + dc-north 2, both ways
  assert.equal(reply.rtt, 2 * (4 + 12 + 62 + 5 + 2));
});

test('traceroute reports each router in order and stops at the destination', async () => {
  const { net, laptop } = perfectWorld();
  const forumIp = net.hostnames.get('forum.mine.net');
  const hops = await net.settle(laptop.traceroute(forumIp));

  assert.equal(hops[0].name, 'isp-taipei', 'the sending host must not burn a hop');
  assert.equal(hops.at(-1).ip, forumIp);
  assert.deepEqual(
    hops.map((hop) => hop.name),
    ['isp-taipei', 'core-asia', 'core-us', 'dc-south', 'srv-forum'],
  );
  for (let i = 1; i < hops.length; i++) assert.equal(hops[i].ttl, hops[i - 1].ttl + 1);
});

test('routing follows the cheapest path, not the fewest hops', async () => {
  const { net, phone } = perfectWorld();
  // San Francisco to the Reykjavík data centre goes over the backbone,
  // never back through the trans-pacific spare.
  const hops = await net.settle(phone.traceroute(net.hostnames.get('www.mine.net')));
  assert.deepEqual(
    hops.map((hop) => hop.name),
    ['isp-sf', 'core-us', 'core-eu', 'dc-north', 'srv-www'],
  );
});

test('a packet with too small a TTL never arrives', async () => {
  const { net, laptop } = perfectWorld();
  const reply = await net.settle(laptop.ping(net.hostnames.get('shop.mine.net'), { ttl: 2 }));
  assert.equal(reply.type, 'ttl-exceeded');
  assert.equal(net.byIp(reply.from).name, 'core-asia');
});

test('an address nobody routes to fails fast instead of retrying', async () => {
  const { net, laptop } = perfectWorld();
  const started = net.clock.now;
  await assert.rejects(
    net.settle(laptop.request('192.0.2.7', 80, { path: '/' }, { timeout: 500, retries: 4 })),
    (error) => error instanceof NetworkError && error.reason === 'destination-unreachable',
  );
  assert.ok(net.clock.now - started < 500, 'should not have waited for a single timeout');
});

test('requests survive a network losing most of its packets', async () => {
  const { net, laptop } = createWorld({ lossScale: 20, seed: 7 });
  const paths = ['mine.net', 'wiki.mine.net/wiki/redstone', 'shop.mine.net/item/cat', 'forum.mine.net/threads/2'];

  for (const path of paths) {
    const page = await net.settle(laptop.fetch(path, { retries: 20 }));
    assert.equal(page.status, 200, `${path} should still load`);
  }

  assert.ok(net.stats.lost > 0, 'the test is pointless if nothing was dropped');
  assert.ok(laptop.transfers.retries > 0, 'the client should have had to ask again');
});

test('the same seed produces the same run', async () => {
  const run = async () => {
    const { net, laptop } = createWorld({ lossScale: 8, seed: 99 });
    await net.settle(laptop.fetch('mine.net'));
    return [net.clock.now, net.stats.lost, laptop.transfers.retries];
  };
  assert.deepEqual(await run(), await run());
});
