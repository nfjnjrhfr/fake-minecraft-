// URL handling for the simulated web. Scheme is always http, port defaults to 80.

export function parseUrl(input, base = null) {
  let raw = String(input ?? '').trim();
  if (!raw) throw new Error('empty url');

  if (raw.startsWith('/') || raw.startsWith('?')) {
    if (!base) throw new Error(`relative url "${raw}" needs a base`);
    const parent = parseUrl(base);
    raw = `http://${parent.hostname}:${parent.port}${raw.startsWith('?') ? parent.path : ''}${raw}`;
  }

  raw = raw.replace(/^http:\/\//i, '');

  const [beforeQuery, ...queryParts] = raw.split('?');
  const queryString = queryParts.join('?');
  const slash = beforeQuery.indexOf('/');
  const authority = slash === -1 ? beforeQuery : beforeQuery.slice(0, slash);
  const path = slash === -1 ? '/' : beforeQuery.slice(slash) || '/';

  const [hostname, portText] = authority.split(':');
  if (!hostname) throw new Error(`bad url: ${input}`);
  const port = portText ? Number(portText) : 80;
  if (!Number.isInteger(port)) throw new Error(`bad port in url: ${input}`);

  const query = {};
  for (const pair of queryString.split('&')) {
    if (!pair) continue;
    const [key, ...rest] = pair.split('=');
    query[decodeURIComponent(key)] = decodeURIComponent(rest.join('=').replace(/\+/g, ' '));
  }

  const href = `http://${hostname.toLowerCase()}${port === 80 ? '' : `:${port}`}${path}${
    queryString ? `?${queryString}` : ''
  }`;

  return { href, hostname: hostname.toLowerCase(), port, path, query, queryString };
}

/** Resolve a link found on a page against the page it was found on. */
export function resolveUrl(href, base) {
  const raw = String(href ?? '').trim();
  if (/^http:\/\//i.test(raw) || (!raw.startsWith('/') && !raw.startsWith('?') && raw.includes('.') && !raw.startsWith('.'))) {
    return parseUrl(raw).href;
  }
  return parseUrl(raw, base).href;
}
