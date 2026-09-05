import { createSite, escapeHtml } from '../site.js';

export function createPortal(directory) {
  const others = () => directory().filter((site) => site.hostname !== 'www.mine.net');

  return createSite({
    hostname: 'www.mine.net',
    title: 'MineNet',
    tagline: 'The front page of a very small internet',
    index: [
      { path: '/', title: 'MineNet — the front page' },
      { path: '/about', title: 'About MineNet' },
    ],
    routes: {
      '/': () => `
        <title>MineNet</title>
        <h1>MineNet</h1>
        <p><i>Six sites, eleven routers, one very patient DNS server.</i></p>
        <h2>Directory</h2>
        <ul>
          ${others()
            .map(
              (site) =>
                `<li><a href="http://${site.hostname}/">${escapeHtml(site.title)}</a> — <small>${escapeHtml(
                  site.tagline,
                )}</small></li>`,
            )
            .join('')}
        </ul>
        <h2>Start here</h2>
        <ul>
          <li><a href="http://wiki.mine.net/wiki/internet">How this internet actually works</a></li>
          <li><a href="http://search.mine.net/?q=redstone">Search for redstone</a></li>
          <li><a href="http://status.mine.net/">Watch the packets</a></li>
        </ul>
        <hr>
        <p><a href="/about">About</a></p>`,

      '/about': () => `
        <title>About MineNet</title>
        <h1>About</h1>
        <p>MineNet is a complete internet that fits in one repository: routers with real
        latency and real packet loss, a routing table computed with Dijkstra, a DNS
        server that is the only machine allowed to read the name table, and a handful
        of sites that only exist because somebody wired them up.</p>
        <p>Nothing here touches a real socket. Every millisecond is a number on a
        virtual clock, which is why a page load takes microseconds of wall time and
        still reports an honest round trip.</p>
        <p><a href="/">Front page</a> · <a href="http://wiki.mine.net/wiki/internet">The long version</a></p>`,
    },
  });
}
