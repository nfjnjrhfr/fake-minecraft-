// A tiny web framework for the sites living on this internet.

import { toText } from './render.js';

export function html(body, { status = 200, headers = {} } = {}) {
  return { status, headers: { 'content-type': 'text/minihtml', ...headers }, body };
}

export function notFound(path) {
  return html(
    `<h1>404</h1><p>No page at <code>${escapeHtml(path)}</code>.</p><p><a href="/">Back to the front page</a></p>`,
    { status: 404 },
  );
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function matchRoute(pattern, path) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  const params = {};

  for (let i = 0; i < patternParts.length; i++) {
    const expected = patternParts[i];
    if (expected === '*') {
      params.rest = pathParts.slice(i).join('/');
      return params;
    }
    const actual = pathParts[i];
    if (actual === undefined) return null;
    if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected.toLowerCase() !== actual.toLowerCase()) return null;
  }

  return patternParts.length === pathParts.length ? params : null;
}

/**
 * @param {object} spec
 * @param {string} spec.hostname
 * @param {string} spec.title
 * @param {Record<string, (req: object, params: object) => object|string>} spec.routes
 * @param {Array<{path: string, title: string, body: string}>} [spec.index] pages the search engine may index
 */
export function createSite({ hostname, title, tagline = '', routes, index = [] }) {
  const entries = Object.entries(routes);

  const handle = (request) => {
    const path = request.path || '/';
    for (const [pattern, handler] of entries) {
      const params = matchRoute(pattern, path);
      if (!params) continue;
      const result = handler(request, params);
      return typeof result === 'string' ? html(result) : result;
    }
    return notFound(path);
  };

  return {
    hostname,
    title,
    tagline,
    handle,
    /** Pages this site offers to the crawler, as { url, title, text }. */
    documents() {
      return index.map((page) => {
        const response = handle({ method: 'GET', path: page.path, host: hostname, query: {} });
        return {
          url: `http://${hostname}${page.path}`,
          title: page.title,
          site: hostname,
          text: toText(response.body ?? ''),
        };
      });
    },
  };
}
