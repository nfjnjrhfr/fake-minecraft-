import { createSite, html, escapeHtml } from '../site.js';

const ARTICLES = {
  redstone: {
    title: 'Redstone',
    summary: 'The dust that made this world programmable.',
    body: `
      <p><b>Redstone</b> is a mineral that carries a signal for fifteen blocks before it
      fades. Everything else — doors, pistons, lamps, the elevator in your base that
      only works on Tuesdays — is built on top of that one rule.</p>
      <h2>Signal strength</h2>
      <p>A signal leaves its source at strength 15 and loses one unit per block of dust.
      A <a href="/wiki/repeater">repeater</a> restores it to 15 and, incidentally, adds
      a tick of delay, which is how anyone builds a clock.</p>
      <h2>The three primitives</h2>
      <ul>
        <li>A source: lever, button, pressure plate, or a <a href="/wiki/creeper">creeper</a> you would rather not have stepped on that plate.</li>
        <li>A wire: dust, repeaters, comparators.</li>
        <li>A sink: piston, lamp, dropper, note block.</li>
      </ul>
      <p>Wire three of those together and you have a circuit. Wire nine hundred together
      and you have a computer that runs at four hertz and takes up a mountain.</p>
      <h2>See also</h2>
      <ul>
        <li><a href="/wiki/repeater">Repeater</a></li>
        <li><a href="/wiki/nether">The Nether</a></li>
      </ul>`,
  },
  repeater: {
    title: 'Repeater',
    summary: 'Restores a redstone signal and delays it by one to four ticks.',
    body: `
      <p>A <b>repeater</b> does two jobs that look like one: it pushes a fading
      <a href="/wiki/redstone">redstone</a> signal back up to strength 15, and it holds
      that signal for a configurable one to four ticks before passing it on.</p>
      <p>It is also a diode. Signal goes in one side and out the other, never back, which
      is the only reason large builds do not immediately turn into one enormous
      short circuit.</p>
      <blockquote>Every clock in this world is two repeaters that refuse to agree.</blockquote>`,
  },
  creeper: {
    title: 'Creeper',
    summary: 'Silent, green, and permanently three seconds from ruining your afternoon.',
    body: `
      <p>The <b>creeper</b> approaches without footsteps, hisses once, and removes a
      sphere of your build along with the chest you had not yet emptied.</p>
      <h2>Field notes</h2>
      <ul>
        <li>It will not explode if it cannot reach you. Fences are cheaper than rebuilding.</li>
        <li>It is afraid of cats, which is the single most useful fact on this wiki.</li>
        <li>A charged creeper — one struck by lightning — is the same problem, squared.</li>
      </ul>
      <p>Discussion of countermeasures continues on
      <a href="http://forum.mine.net/threads/1">the forum</a>, mostly in the form of
      people posting screenshots of holes.</p>`,
  },
  nether: {
    title: 'The Nether',
    summary: 'A compressed dimension: one block there is eight blocks at home.',
    body: `
      <p>The <b>Nether</b> is a smaller, hotter copy of the world where distance is
      divided by eight. Walk one hundred blocks through the heat and you have travelled
      eight hundred blocks at home.</p>
      <p>This is why every serious base ends up connected by a tunnel through a place
      actively trying to set the traveller on fire: it is the fastest road available.</p>
      <h2>Portal arithmetic</h2>
      <pre>overworld x, z  ->  nether x/8, z/8
nether  x, z  ->  overworld x*8, z*8</pre>
      <p>Get the arithmetic wrong and two portals link to each other instead of to the
      places you wanted, which is the leading cause of arriving in someone else's
      basement.</p>`,
  },
  crafting: {
    title: 'Crafting',
    summary: 'A three by three grid, and the entire economy that grew out of it.',
    body: `
      <p><b>Crafting</b> is pattern matching. Nine slots, one output, and a table of
      shapes that somebody memorised so you would not have to.</p>
      <p>The <a href="http://shop.mine.net/">Blockmarket</a> exists entirely because
      players would rather trade for a finished item than remember which corner the
      stick goes in.</p>`,
  },
  internet: {
    title: 'The Internet',
    summary: 'Packets, hops, and the polite fiction that a page arrives all at once.',
    body: `
      <p>This wiki, the forum, the shop and the search engine are all reachable because
      of a stack of small agreements: names map to addresses, addresses map to routes,
      and routes are just a list of who to hand the packet to next.</p>
      <h2>What actually happens when you open a page</h2>
      <ol>
        <li>Your machine asks a resolver for the address behind a name.</li>
        <li>It sends a request packet toward that address.</li>
        <li>Every router on the way looks at the destination, picks a neighbour, and forgets you existed.</li>
        <li>Somewhere a server answers, and the reply retraces a path that may not be the one you took.</li>
      </ol>
      <p>Packets get lost. The interesting part is that nothing above the packet layer
      is allowed to care: it just asks again.</p>
      <p>Watch it happen live at <a href="http://status.mine.net/">status.mine.net</a>.</p>`,
  },
};

export function createWiki() {
  const list = Object.entries(ARTICLES).map(([slug, article]) => ({ slug, ...article }));

  return createSite({
    hostname: 'wiki.mine.net',
    title: 'The Block Wiki',
    tagline: 'Everything anyone bothered to write down',
    index: [
      { path: '/', title: 'The Block Wiki' },
      ...list.map((article) => ({ path: `/wiki/${article.slug}`, title: article.title })),
    ],
    routes: {
      '/': () => `
        <title>The Block Wiki</title>
        <h1>The Block Wiki</h1>
        <p>${list.length} articles. Nobody is checking them.</p>
        <ul>
          ${list
            .map(
              (article) =>
                `<li><a href="/wiki/${article.slug}">${escapeHtml(article.title)}</a> — <small>${escapeHtml(
                  article.summary,
                )}</small></li>`,
            )
            .join('')}
        </ul>
        <p><a href="http://www.mine.net/">Front page</a> · <a href="http://search.mine.net/">Search</a></p>`,

      '/wiki/:slug': (request, { slug }) => {
        const article = ARTICLES[String(slug).toLowerCase()];
        if (!article) {
          return html(
            `<h1>No such article</h1><p>Nobody has written <b>${escapeHtml(slug)}</b> yet.</p>
             <p><a href="/">All articles</a></p>`,
            { status: 404 },
          );
        }
        return `
          <title>${escapeHtml(article.title)}</title>
          <h1>${escapeHtml(article.title)}</h1>
          <p><i>${escapeHtml(article.summary)}</i></p>
          ${article.body}
          <hr>
          <p><a href="/">All articles</a> · <a href="http://www.mine.net/">Front page</a></p>`;
      },
    },
  });
}
