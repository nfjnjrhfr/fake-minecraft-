import { createSite, escapeHtml } from '../site.js';

/** A live view of the network the page is being served over. */
export function createStatus(net) {
  const pad = (text, width) => String(text).padEnd(width);

  return createSite({
    hostname: 'status.mine.net',
    title: 'Network Weather',
    tagline: 'Every packet this internet has ever moved',
    index: [{ path: '/', title: 'Network Weather' }],
    routes: {
      '/': () => {
        const routers = [...net.nodes.values()].filter((node) => node.kind === 'router');
        const hosts = [...net.nodes.values()].filter((node) => node.kind === 'host');
        const { forwarded, lost, expired, unreachable } = net.stats;
        const lossRate = forwarded + lost ? ((lost / (forwarded + lost)) * 100).toFixed(2) : '0.00';

        return `
          <title>Network Weather</title>
          <h1>Network Weather</h1>
          <p>Virtual clock: <b>${net.clock.now} ms</b> · ${routers.length} routers ·
          ${hosts.length} hosts · ${net.links.length} links</p>
          <h2>Counters</h2>
          <pre>${pad('forwarded', 24)}${forwarded}
${pad('dropped (loss)', 24)}${lost}
${pad('dropped (ttl)', 24)}${expired}
${pad('dropped (no route)', 24)}${unreachable}
${pad('observed loss', 24)}${lossRate}%</pre>
          <h2>Busiest routers</h2>
          <pre>${routers
            .slice()
            .sort((a, b) => b.stats.forwarded - a.stats.forwarded)
            .slice(0, 6)
            .map((node) => `${pad(node.name, 16)}${pad(node.ip, 14)}${String(node.stats.forwarded).padStart(6)} pkt`)
            .join('\n')}</pre>
          <p><a href="/links">Link weather</a> · <a href="http://www.mine.net/">Front page</a></p>`;
      },

      '/links': () => `
        <title>Link weather</title>
        <h1>Link weather</h1>
        <p>Latency is one-way, in milliseconds. Loss is applied per traversal.</p>
        <pre>${net.links
          .map(
            (link) =>
              `${String(`${link.a} ↔ ${link.b}`).padEnd(34)}${String(`${link.latency}ms`).padStart(7)}${String(
                `${(link.loss * 100).toFixed(1)}% loss`,
              ).padStart(14)}`,
          )
          .join('\n')}</pre>
        <p><a href="/">Back to the weather</a></p>`,

      '/whoami': (request) => `
        <title>whoami</title>
        <h1>whoami</h1>
        <p>You asked for <code>${escapeHtml(request.host ?? '')}${escapeHtml(request.path)}</code>.</p>
        <p>This page was rendered at virtual clock <b>${net.clock.now} ms</b>.</p>`,
    },
  });
}
