/**
 * A small Markdown renderer. SGPT runs offline-friendly with no CDN, so this
 * covers what the model actually emits — fenced code, inline code, headings,
 * lists, tables, blockquotes, links, emphasis — instead of pulling in a parser.
 *
 * Everything is escaped before any tag is inserted; the only HTML that reaches
 * the DOM is generated here.
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** Reverse escapeHtml. Used where escaped text has to become plain text again. */
export function unescapeHtml(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Inline formatting, applied to already-escaped text. */
function inline(text) {
  const codeSpans = [];
  // Pull code spans out first so their contents are never re-formatted. The
  // placeholder survives escaping because the input is escaped already.
  let out = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    codeSpans.push(code);
    return `@@SGPTCODE${codeSpans.length - 1}@@`;
  });

  out = out
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) =>
      /^(https?:|data:image\/)/i.test(src)
        ? `<img src="${src}" alt="${alt}" loading="lazy">`
        : alt,
    )
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) =>
      // Only http(s) and mailto links become anchors — no javascript: URLs.
      /^(https?:|mailto:)/i.test(href)
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : m,
    )
    .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?])/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");

  return out.replace(
    /@@SGPTCODE(\d+)@@/g,
    (_m, i) => `<code>${codeSpans[Number(i)]}</code>`,
  );
}

function renderTable(rows) {
  const cells = (line) =>
    line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
  const tb = body
    .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
}

const isTableDivider = (line) =>
  /^\s*\|?[\s:-]*-[-\s|:]*\|?\s*$/.test(line) && line.includes("-");

export function renderMarkdown(source) {
  const lines = escapeHtml(source ?? "").split("\n");
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block — copied out verbatim, with the language kept for the header.
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2] || "";
      const buf = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*\\${marker}{3,}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      const code = buf.join("\n");
      html.push(
        // data-code carries the original source so "copy" yields real text,
        // not the HTML-escaped form shown in the <pre>.
        `<figure class="code-block" data-code="${encodeURIComponent(unescapeHtml(code))}">` +
          `<figcaption><span>${lang || "code"}</span>` +
          `<button type="button" class="copy-code">複製</button></figcaption>` +
          `<pre><code>${code}</code></pre></figure>`,
      );
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      html.push("<hr>");
      i += 1;
      continue;
    }

    // Table: a header row followed by a divider row.
    if (line.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(lines[i]);
        i += 1;
      }
      html.push(renderTable(rows));
      continue;
    }

    if (/^\s*&gt;/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*&gt;/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, ""));
        i += 1;
      }
      // Already-escaped text goes back through the block parser, so undo the
      // escaping it is about to redo.
      const inner = unescapeHtml(buf.join("\n"));
      html.push(`<blockquote>${renderMarkdown(inner)}</blockquote>`);
      continue;
    }

    const listKind = /^\s*([-*+])\s+/.test(line)
      ? "ul"
      : /^\s*\d+[.)]\s+/.test(line)
        ? "ol"
        : null;
    if (listKind) {
      const items = [];
      const matcher = listKind === "ul" ? /^\s*[-*+]\s+/ : /^\s*\d+[.)]\s+/;
      while (i < lines.length && matcher.test(lines[i])) {
        let item = lines[i].replace(matcher, "");
        i += 1;
        // Fold indented continuation lines into the same item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !matcher.test(lines[i])) {
          item += " " + lines[i].trim();
          i += 1;
        }
        items.push(`<li>${inline(item)}</li>`);
      }
      html.push(`<${listKind}>${items.join("")}</${listKind}>`);
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(#{1,6}\s|&gt;|```|~~~|---|\*\*\*|___)/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length) html.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }

  return html.join("");
}
