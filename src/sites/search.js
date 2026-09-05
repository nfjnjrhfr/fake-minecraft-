import { createSite, escapeHtml } from '../site.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'that', 'this',
  'for', 'on', 'at', 'as', 'by', 'be', 'are', 'was', 'you', 'your', 'with',
]);

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/** An inverted index over the crawled corpus. */
export function buildIndex(documents) {
  const postings = new Map(); // term -> Map(docId -> term frequency)
  documents.forEach((doc, docId) => {
    const counts = new Map();
    for (const term of tokenize(`${doc.title} ${doc.text}`)) counts.set(term, (counts.get(term) ?? 0) + 1);
    doc.length = Math.max(1, [...counts.values()].reduce((sum, n) => sum + n, 0));
    for (const [term, count] of counts) {
      if (!postings.has(term)) postings.set(term, new Map());
      postings.get(term).set(docId, count);
    }
  });

  return {
    documents,
    size: documents.length,
    search(query, limit = 10) {
      const terms = tokenize(query);
      if (!terms.length) return [];
      const scores = new Map();

      for (const term of terms) {
        const hits = postings.get(term);
        if (!hits) continue;
        const idf = Math.log(1 + documents.length / hits.size);
        for (const [docId, count] of hits) {
          const doc = documents[docId];
          const titleBoost = doc.title.toLowerCase().includes(term) ? 4 : 0;
          const score = (count / doc.length) * idf * 10 + titleBoost;
          scores.set(docId, (scores.get(docId) ?? 0) + score);
        }
      }

      return [...scores.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, limit)
        .map(([docId, score]) => ({ ...documents[docId], score: Number(score.toFixed(3)), snippet: snippet(documents[docId].text, terms) }));
    },
  };
}

function snippet(text, terms, width = 150) {
  const haystack = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = haystack.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  const start = at === -1 ? 0 : Math.max(0, at - 50);
  const cut = text.slice(start, start + width).trim();
  return `${start > 0 ? '…' : ''}${cut}${start + width < text.length ? '…' : ''}`;
}

/**
 * @param {() => Array<{url:string,title:string,text:string,site:string}>} crawl
 *   called once, lazily, so every other site exists before the crawler runs.
 */
export function createSearch(crawl) {
  let index = null;
  const ready = () => (index ??= buildIndex(crawl()));

  const searchBox = (query = '') => `
    <p><small>Search from the CLI: <code>net search "${escapeHtml(query || 'redstone')}"</code>
    or open <code>search.mine.net/?q=...</code></small></p>`;

  return createSite({
    hostname: 'search.mine.net',
    title: 'Deepslate Search',
    tagline: 'It crawled six sites and it is very proud of that',
    index: [{ path: '/', title: 'Deepslate Search' }],
    routes: {
      '/': (request) => {
        const query = String(request.query?.q ?? '').trim();
        const engine = ready();
        if (!query) {
          return `
            <title>Deepslate Search</title>
            <h1>Deepslate Search</h1>
            <p>${engine.size} pages indexed across ${new Set(engine.documents.map((d) => d.site)).size} sites.</p>
            ${searchBox()}
            <h2>Try one of these</h2>
            <ul>
              <li><a href="/?q=redstone">redstone</a></li>
              <li><a href="/?q=creeper+cat">creeper cat</a></li>
              <li><a href="/?q=portal+arithmetic">portal arithmetic</a></li>
              <li><a href="/?q=packets">packets</a></li>
            </ul>
            <p><a href="http://www.mine.net/">Front page</a></p>`;
        }

        const results = engine.search(query);
        return `
          <title>${escapeHtml(query)} — Deepslate Search</title>
          <h1>Results for “${escapeHtml(query)}”</h1>
          <p>${results.length} of ${engine.size} indexed pages.</p>
          ${
            results.length
              ? `<ul>${results
                  .map(
                    (result) => `<li><a href="${escapeHtml(result.url)}">${escapeHtml(result.title)}</a>
                      <br><small>${escapeHtml(result.site)} · score ${result.score}</small>
                      <br>${escapeHtml(result.snippet)}</li>`,
                  )
                  .join('')}</ul>`
              : '<p>Nothing. Try fewer words, or words that exist.</p>'
          }
          ${searchBox(query)}
          <p><a href="/">New search</a> · <a href="http://www.mine.net/">Front page</a></p>`;
      },
    },
  });
}
