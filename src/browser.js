// A browser: fetch a page over the simulated network, render it, remember where
// you have been, and let you follow the numbered links.

import { render } from './render.js';
import { resolveUrl } from './url.js';

export class Browser {
  constructor(host, { width = 76, color = false } = {}) {
    this.host = host;
    this.width = width;
    this.color = color;
    this.history = [];
    this.page = null;
  }

  get net() {
    return this.host.net;
  }

  async load(url, { method = 'GET', body = null, record = true } = {}) {
    const response = await this.host.fetch(url, { method, body });
    const rendered = render(response.body ?? '', { width: this.width, color: this.color });
    const page = {
      url: response.url,
      status: response.status,
      hostname: response.hostname,
      ip: response.ip,
      ms: response.ms,
      title: rendered.title ?? response.hostname,
      text: rendered.text,
      links: rendered.links,
    };
    if (record && this.page) this.history.push(this.page.url);
    this.page = page;
    return page;
  }

  /** Follow the nth numbered link on the current page. */
  follow(n) {
    if (!this.page) throw new Error('no page open');
    const link = this.page.links[n - 1];
    if (!link) throw new Error(`no link [${n}] on this page`);
    return this.load(resolveUrl(link.href, this.page.url));
  }

  back() {
    const previous = this.history.pop();
    if (!previous) throw new Error('no page to go back to');
    return this.load(previous, { record: false });
  }

  reload() {
    if (!this.page) throw new Error('no page open');
    return this.load(this.page.url, { record: false });
  }
}
