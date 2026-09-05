import test from 'node:test';
import assert from 'node:assert/strict';

import { render, toText, stripAnsi } from '../src/render.js';
import { parseUrl, resolveUrl } from '../src/url.js';
import { buildIndex, tokenize } from '../src/sites/search.js';

test('headings, lists and preformatted text survive rendering', () => {
  const { text } = render(
    '<h1>Title</h1><p>Some words that keep going for a while.</p><ul><li>one</li><li>two</li></ul><pre>x = 1\ny = 2</pre>',
    { width: 30 },
  );
  const lines = text.split('\n');

  assert.equal(lines[0], 'Title');
  assert.equal(lines[1], '═'.repeat(5));
  assert.ok(lines.some((line) => line === '  • one'));
  assert.ok(lines.some((line) => line === '    x = 1'));
  assert.ok(lines.every((line) => line.length <= 30));
});

test('links are numbered in document order and reported with their targets', () => {
  const { text, links } = render('<p>See <a href="/a">first</a> and <a href="http://b.net/">second</a>.</p>');

  assert.deepEqual(
    links.map((link) => [link.index, link.label, link.href]),
    [
      [1, 'first', '/a'],
      [2, 'second', 'http://b.net/'],
    ],
  );
  assert.ok(text.includes('first[1]'));
  assert.ok(text.includes('second[2]'));
});

test('entities are decoded and colour is optional', () => {
  const plain = render('<p>a &amp; b &lt;tag&gt;</p>');
  assert.equal(plain.text, 'a & b <tag>');

  const coloured = render('<p><b>bold</b></p>', { color: true });
  assert.notEqual(coloured.text, stripAnsi(coloured.text));
  assert.equal(stripAnsi(coloured.text), 'bold');
});

test('toText strips markup for the indexer', () => {
  assert.equal(toText('<h1>Hi</h1><p>there   you</p>'), 'Hi there you');
});

test('urls resolve the way a browser resolves them', () => {
  assert.deepEqual(
    (({ hostname, path, port, query }) => ({ hostname, path, port, query }))(parseUrl('http://Shop.Mine.net:80/item/cat?q=a+b')),
    { hostname: 'shop.mine.net', path: '/item/cat', port: 80, query: { q: 'a b' } },
  );
  assert.equal(parseUrl('mine.net').path, '/');
  assert.equal(resolveUrl('/wiki/nether', 'http://wiki.mine.net/wiki/redstone'), 'http://wiki.mine.net/wiki/nether');
  assert.equal(resolveUrl('http://shop.mine.net/', 'http://wiki.mine.net/'), 'http://shop.mine.net/');
  assert.equal(resolveUrl('?q=cat', 'http://search.mine.net/'), 'http://search.mine.net/?q=cat');
});

test('the index ranks a title match above a passing mention', () => {
  const index = buildIndex([
    { url: 'a', site: 's', title: 'Creeper', text: 'green and quiet' },
    { url: 'b', site: 's', title: 'Walls', text: 'a creeper removed this wall, the wall is gone' },
    { url: 'c', site: 's', title: 'Bread', text: 'wheat, mostly' },
  ]);

  const results = index.search('creeper');
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'a');
  assert.ok(results[0].snippet.length > 0);
  assert.deepEqual(index.search('zzz'), []);
});

test('stopwords and punctuation are dropped from queries', () => {
  assert.deepEqual(tokenize('The creeper, and the WALL!'), ['creeper', 'wall']);
});
