// Builds the whole internet: backbone, ISPs, data centres, servers, clients.

import { Internet } from './network.js';
import { Host, createResolver } from './host.js';
import { createPortal } from './sites/portal.js';
import { createWiki } from './sites/wiki.js';
import { createSearch } from './sites/search.js';
import { createForum } from './sites/forum.js';
import { createShop } from './sites/shop.js';
import { createStatus } from './sites/status.js';

const BACKBONE = [
  ['core-asia', '10.0.0.1', 'Singapore'],
  ['core-eu', '10.0.0.2', 'Frankfurt'],
  ['core-us', '10.0.0.3', 'Ashburn'],
];

const EDGE = [
  ['isp-taipei', '10.1.0.1', 'Taipei', 'core-asia', 12],
  ['isp-tokyo', '10.2.0.1', 'Tokyo', 'core-asia', 18],
  ['isp-berlin', '10.3.0.1', 'Berlin', 'core-eu', 10],
  ['isp-london', '10.4.0.1', 'London', 'core-eu', 14],
  ['isp-nyc', '10.5.0.1', 'New York', 'core-us', 9],
  ['isp-sf', '10.6.0.1', 'San Francisco', 'core-us', 16],
  ['dc-north', '10.7.0.1', 'Hafnarfjördur', 'core-eu', 5],
  ['dc-south', '10.8.0.1', 'São Paulo', 'core-us', 6],
];

const prefixOf = (ip) => ip.split('.').slice(0, 3).join('.');

export function createWorld({ seed = 20260905, lossScale = 1, jitter = 0.12 } = {}) {
  const net = new Internet({ seed, jitter });

  for (const [name, ip, location] of BACKBONE) net.addRouter(name, ip, { location });
  net.link('core-asia', 'core-eu', { latency: 62, loss: 0.01 * lossScale });
  net.link('core-eu', 'core-us', { latency: 44, loss: 0.01 * lossScale });
  net.link('core-us', 'core-asia', { latency: 83, loss: 0.03 * lossScale });

  for (const [name, ip, location, upstream, latency] of EDGE) {
    net.addRouter(name, ip, { location });
    net.link(name, upstream, { latency, loss: 0.005 * lossScale });
  }
  // A second path home, so a busy backbone link is not a single point of failure.
  net.link('isp-tokyo', 'isp-sf', { latency: 96, loss: 0.02 * lossScale, label: 'trans-pacific spare' });

  const attach = (name, router, { latency = 1, location = '', dnsIp = null } = {}) => {
    const routerNode = net.nodes.get(router);
    const host = net.addNode(
      new Host(net, { name, ip: net.allocateIp(prefixOf(routerNode.ip)), location: location || routerNode.location, dnsIp }),
    );
    net.link(name, router, { latency, loss: 0 });
    return host;
  };

  // The resolver comes first: everyone else needs its address.
  const ns1 = attach('ns1', 'dc-north', { latency: 2 });
  createResolver(net, ns1);
  net.register('ns1.mine.net', ns1.ip);

  const sites = [];
  const directory = () => sites;

  const servers = [
    [createPortal(directory), 'dc-north'],
    [createWiki(), 'dc-north'],
    [createStatus(net), 'dc-north'],
    [createForum(), 'dc-south'],
    [createShop(), 'dc-south'],
    // The crawler skips the search engine itself — indexing your own results
    // page is how a search engine eats its own tail.
    [
      createSearch(() =>
        sites.filter((site) => site.hostname !== 'search.mine.net').flatMap((site) => site.documents()),
      ),
      'dc-south',
    ],
  ];

  for (const [site, router] of servers) {
    const host = attach(`srv-${site.hostname.split('.')[0]}`, router, { latency: 2, dnsIp: ns1.ip });
    host.listen(80, (request) => site.handle(request));
    host.site = site;
    net.register(site.hostname, host.ip);
    sites.push(site);
  }

  // Bare "mine.net" should land on the front page too.
  net.register('mine.net', net.hostnames.get('www.mine.net'));

  const laptop = attach('laptop', 'isp-taipei', { latency: 4, dnsIp: ns1.ip });
  const phone = attach('phone', 'isp-sf', { latency: 9, dnsIp: ns1.ip });

  net.computeRoutes();

  return { net, sites, ns1, laptop, phone, client: laptop };
}
