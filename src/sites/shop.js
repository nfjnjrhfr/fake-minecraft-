import { createSite, html, escapeHtml } from '../site.js';

const ITEMS = [
  { slug: 'redstone-dust', name: 'Redstone dust', price: 3, stock: 4096, blurb: 'Sold by the stack. Fades after fifteen blocks; buy repeaters.' },
  { slug: 'repeater', name: 'Repeater', price: 14, stock: 231, blurb: 'Restores a signal and delays it. Every clock is two of these arguing.' },
  { slug: 'piston', name: 'Sticky piston', price: 22, stock: 88, blurb: 'Pushes a block, then takes it back. Emotionally complicated.' },
  { slug: 'obsidian', name: 'Obsidian', price: 40, stock: 512, blurb: 'Creeper-proof. Diamond-pickaxe-only. Heavy in every sense.' },
  { slug: 'cat', name: 'Cat (pre-owned)', price: 96, stock: 3, blurb: 'Frightens creepers. Does not respect your building plans.' },
  { slug: 'elytra', name: 'Elytra', price: 1200, stock: 1, blurb: 'One pair. No refunds. Read the durability section first.' },
];

export function createShop() {
  const bySlug = (slug) => ITEMS.find((item) => item.slug === String(slug).toLowerCase());

  return createSite({
    hostname: 'shop.mine.net',
    title: 'The Blockmarket',
    tagline: 'Emeralds only',
    index: [
      { path: '/', title: 'The Blockmarket' },
      ...ITEMS.map((item) => ({ path: `/item/${item.slug}`, title: item.name })),
    ],
    routes: {
      '/': (request) => {
        const query = String(request.query?.q ?? '').toLowerCase();
        const shown = query ? ITEMS.filter((item) => `${item.name} ${item.blurb}`.toLowerCase().includes(query)) : ITEMS;
        return `
          <title>The Blockmarket</title>
          <h1>The Blockmarket</h1>
          <p>${shown.length} listings${query ? ` matching <b>${escapeHtml(query)}</b>` : ''}. Prices in emeralds.</p>
          <ul>
            ${shown
              .map(
                (item) =>
                  `<li><a href="/item/${item.slug}">${escapeHtml(item.name)}</a> — <b>${item.price}e</b> <small>(${
                    item.stock
                  } in stock)</small></li>`,
              )
              .join('')}
          </ul>
          <p><a href="http://www.mine.net/">Front page</a></p>`;
      },

      '/item/:slug': (request, { slug }) => {
        const item = bySlug(slug);
        if (!item) return html('<h1>Sold out of that entirely</h1><p><a href="/">All listings</a></p>', { status: 404 });
        return `
          <title>${escapeHtml(item.name)}</title>
          <h1>${escapeHtml(item.name)}</h1>
          <p><b>${item.price} emeralds</b> · <small>${item.stock} in stock</small></p>
          <p>${escapeHtml(item.blurb)}</p>
          <hr>
          <p><a href="/">All listings</a> · <a href="http://wiki.mine.net/wiki/crafting">Craft it yourself</a></p>`;
      },
    },
  });
}
