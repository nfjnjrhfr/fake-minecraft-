# fake-minecraft-

A whole internet in one repository — routers, links with latency and packet
loss, DNS, an HTTP-ish protocol, six websites and a browser you drive from the
terminal. No sockets are involved: every millisecond is a number on a virtual
clock, so a page load takes microseconds of wall time and still reports an
honest round trip.

```
$ node bin/net.js demo          # the guided tour
$ node bin/net.js browse        # open the web and click around
$ npm test                      # 25 tests, no dependencies
```

Node 18+. No dependencies, nothing to install.

## What you can do

```
net demo                        take the tour
net browse [url]                interactive browser (default: mine.net)
net get <url>                   fetch and render one page
net search <words...>           query the search engine
net post <thread> <who> <text>  reply on the forum — it really changes the page
net dig <hostname>              ask the resolver for an address
net ping <host|ip> [-c n]       echo probes with real round trips
net traceroute <host|ip>        the path your packets take
net map                         the topology and its link weather
net sites                       what is hosted here
```

Options: `--from laptop|phone` (which machine you are sitting at), `--loss <scale>`
(multiply every link's loss rate; `--loss 0` for a perfect network, `--loss 20`
for a terrible one), `--seed <n>`, `--trace` (dump the packet log), `--width <n>`,
`--no-color`.

In the browser, links are numbered `[1]`, `[2]`, …; type a number to follow one,
`b` to go back, `r` to reload, a URL to jump, `q` to quit.

## What it looks like

```
$ node bin/net.js traceroute forum.mine.net
traceroute to forum.mine.net (10.8.0.10), 20 hops max
   1  isp-taipei     10.1.0.1     8ms
   2  core-asia      10.0.0.1     32ms
   3  core-us        10.0.0.3     189ms
   4  dc-south       10.8.0.1     227ms
   5  srv-forum      10.8.0.10    210ms

$ node bin/net.js --trace dig wiki.mine.net
; resolver 10.7.0.10 (ns1)
wiki.mine.net            A   10.7.0.12

--- packet log (12 events) ---
     0ms  forward          at=laptop to=isp-taipei id=p1 latency=4
     4ms  forward          at=isp-taipei to=core-asia id=p1 latency=12
    16ms  forward          at=core-asia to=core-eu id=p1 latency=64
    ...
```

Turn the loss up and watch the difference between a protocol that retries and
one that does not:

```
$ node bin/net.js --loss 12 ping search.mine.net -c 5   # four of five probes vanish
$ node bin/net.js --loss 12 get search.mine.net         # the page still loads
```

## How it is built

Each layer only knows about the one below it, the same way the real stack is
arranged.

| Layer | File | What it does |
| --- | --- | --- |
| Virtual clock | `src/clock.js` | Every latency, timeout and retry is an event on one queue. Deterministic, and as fast as the CPU. |
| Packets & routing | `src/network.js` | Nodes, links, Dijkstra over link latency, per-hop TTL, jitter, loss, ICMP (`echo-reply`, `ttl-exceeded`, `destination-unreachable`). |
| Hosts | `src/host.js` | Ports, request/response with retries, the DNS resolver, `fetch`. |
| Sites | `src/site.js`, `src/sites/*` | A tiny web framework: route patterns, `minihtml`, a crawlable page index. |
| Browser | `src/browser.js`, `src/render.js` | Renders `minihtml` to terminal text, numbers the links, keeps history. |
| World | `src/world.js` | Wires up the backbone, ISPs, data centres, servers and clients. |
| Client | `bin/net.js` | `dig`, `ping`, `traceroute`, `get`, `search`, `post`, `browse`. |

Some deliberate details:

- **Names only come from DNS.** A client cannot read the global name table; it
  has to ask `ns1`, and it caches what it hears. `net dig nothing.mine.net`
  returns NXDOMAIN, exactly like a resolver that has nothing to say.
- **The sending host does not burn a TTL**, so `traceroute`'s first hop is the
  first *router*, which is what a real traceroute shows.
- **Loss is per link traversal**, drawn from a seeded PRNG. Requests retry;
  `ping` does not. That difference is the whole point of the `--loss` flag.
- **Routing is cheapest-path, not fewest-hops.** There is a trans-pacific spare
  link between Tokyo and San Francisco that is deliberately slow, so nothing
  routes over it unless the shorter path would be longer in milliseconds.
- **The crawler skips the search engine itself** — indexing your own results
  page is how a search engine eats its own tail.

## The web that lives here

| Site | What it is |
| --- | --- |
| `www.mine.net` | The front page and directory |
| `wiki.mine.net` | Six articles, including [how this internet works](src/sites/wiki.js) |
| `search.mine.net` | An inverted index over every other site, with tf-idf-ish ranking |
| `forum.mine.net` | Threads you can actually post to (`net post 1 you "hello"`) |
| `shop.mine.net` | Listings, in emeralds |
| `status.mine.net` | Live counters for the network you are reading it over |

## Adding your own site

```js
// src/sites/mysite.js
import { createSite } from '../site.js';

export function createMySite() {
  return createSite({
    hostname: 'mine.example',
    title: 'My Site',
    tagline: 'It is mine',
    index: [{ path: '/', title: 'My Site' }],      // what the crawler may index
    routes: {
      '/': () => '<h1>Hello</h1><p><a href="http://www.mine.net/">Home</a></p>',
      '/thing/:id': (request, { id }) => `<h1>Thing ${id}</h1>`,
    },
  });
}
```

Add `[createMySite(), 'dc-south']` to the `servers` list in `src/world.js` and it
gets a host, an IP, a DNS record and a place in the search index. `net get
mine.example` will reach it.

Supported markup (`minihtml`): `h1`–`h3`, `p`, `ul`/`ol`/`li`, `a`, `b`, `i`,
`code`, `small`, `pre`, `blockquote`, `hr`, `br`, `title`.

## Tests

`npm test` runs 25 tests with `node --test`: routing tables, path latency
arithmetic, TTL and traceroute behaviour, fail-fast on unroutable addresses,
recovery through 20× packet loss, seed determinism, DNS, 404s, refused ports,
link-following and history, search ranking, a forum post changing the page, and
the renderer.
