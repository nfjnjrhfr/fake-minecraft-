import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld } from '../src/world.js';
import { Browser } from '../src/browser.js';
import { NetworkError } from '../src/host.js';

const perfectWorld = () => createWorld({ lossScale: 0, jitter: 0 });

test('DNS is the only way a client learns an address', async () => {
  const { net, laptop } = perfectWorld();
  assert.equal(laptop.dnsCache.size, 0);

  const ip = await net.settle(laptop.resolve('shop.mine.net'));
  assert.equal(ip, net.hostnames.get('shop.mine.net'));
  assert.equal(laptop.dnsCache.get('shop.mine.net'), ip, 'the answer should be cached');

  await assert.rejects(
    net.settle(laptop.resolve('nothing.mine.net')),
    (error) => error instanceof NetworkError && error.reason === 'nxdomain',
  );
});

test('a page is fetched over the network and comes back rendered', async () => {
  const { net, laptop } = perfectWorld();
  const browser = new Browser(laptop, { width: 60 });
  const page = await net.settle(browser.load('mine.net'));

  assert.equal(page.status, 200);
  assert.equal(page.title, 'MineNet');
  assert.equal(page.ip, net.hostnames.get('www.mine.net'));
  assert.equal(page.ms, 2 * (4 + 12 + 62 + 5 + 2));
  assert.ok(page.links.length >= 5);
  assert.ok(page.text.includes('MineNet'));
  assert.ok(page.text.split('\n').every((line) => line.length <= 60));
});

test('a missing page answers 404 rather than hanging', async () => {
  const { net, laptop } = perfectWorld();
  const response = await net.settle(laptop.fetch('wiki.mine.net/wiki/enchanting'));
  assert.equal(response.status, 404);
});

test('a port nobody is listening on is refused', async () => {
  const { net, laptop } = perfectWorld();
  await assert.rejects(
    net.settle(laptop.fetch('wiki.mine.net:8080/')),
    (error) => error instanceof NetworkError && error.reason === 'refused',
  );
});

test('following links and going back walks the web', async () => {
  const { net, laptop } = perfectWorld();
  const browser = new Browser(laptop, { width: 76 });

  await net.settle(browser.load('mine.net'));
  const wiki = await net.settle(browser.follow(1));
  assert.equal(wiki.hostname, 'wiki.mine.net');

  const article = await net.settle(browser.follow(1));
  assert.equal(article.url, 'http://wiki.mine.net/wiki/redstone');

  const back = await net.settle(browser.back());
  assert.equal(back.url, 'http://wiki.mine.net/');
});

test('the search engine indexes the other sites and ranks them', async () => {
  const { net, laptop } = perfectWorld();
  const browser = new Browser(laptop, { width: 76 });
  const results = await net.settle(browser.load('search.mine.net/?q=redstone+repeater'));

  assert.equal(results.status, 200);
  const first = results.links.find((link) => link.href.includes('/wiki/'));
  assert.ok(first, 'a wiki article should be among the results');
  assert.ok(!results.text.includes('search.mine.net ·'), 'the crawler must not index itself');

  const article = await net.settle(browser.load(first.href));
  assert.equal(article.status, 200);
});

test('posting to the forum changes what the next reader sees', async () => {
  const { net, laptop } = perfectWorld();
  const before = await net.settle(laptop.fetch('forum.mine.net/threads/2'));
  assert.ok(!before.body.includes('a mountain of gravel'));

  const posted = await net.settle(
    laptop.fetch('forum.mine.net/threads/2', {
      method: 'POST',
      body: { author: 'tester', text: 'a mountain of gravel would have been cheaper' },
    }),
  );
  assert.equal(posted.status, 201);

  const after = await net.settle(laptop.fetch('forum.mine.net/threads/2'));
  assert.ok(after.body.includes('a mountain of gravel'));
});

test('an empty reply is rejected', async () => {
  const { net, laptop } = perfectWorld();
  const response = await net.settle(
    laptop.fetch('forum.mine.net/threads/2', { method: 'POST', body: { author: 'tester', text: '  ' } }),
  );
  assert.equal(response.status, 400);
});

test('the status site reports the traffic it is being read over', async () => {
  const { net, laptop } = perfectWorld();
  await net.settle(laptop.fetch('mine.net'));
  const status = await net.settle(laptop.fetch('status.mine.net'));

  assert.match(status.body, /forwarded\s+\d+/);
  assert.ok(net.stats.forwarded > 0);
});

test('two clients see the same web from different distances', async () => {
  const { net, laptop, phone } = perfectWorld();
  const fromLaptop = await net.settle(laptop.fetch('mine.net'));
  const fromPhone = await net.settle(phone.fetch('mine.net'));

  assert.equal(fromLaptop.body, fromPhone.body);
  assert.notEqual(fromLaptop.ms, fromPhone.ms);
});
