// Renders "minihtml" — the small tag subset the sites in this internet serve —
// into text for a terminal, collecting the links so a browser can follow them.

const ANSI = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  reset: '\x1b[0m',
};

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  hellip: '…',
};

export function decodeEntities(text) {
  return String(text).replace(/&([a-z#0-9]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

export function visibleWidth(text) {
  return stripAnsi(text).length;
}

export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function wrap(text, width, firstPrefix = '', contPrefix = '') {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = firstPrefix;
  let currentWidth = visibleWidth(firstPrefix);
  let empty = true;

  for (const word of words) {
    const wordWidth = visibleWidth(word);
    if (!empty && currentWidth + 1 + wordWidth > width) {
      lines.push(current);
      current = contPrefix + word;
      currentWidth = visibleWidth(contPrefix) + wordWidth;
      continue;
    }
    current += empty ? word : ` ${word}`;
    currentWidth += empty ? wordWidth : wordWidth + 1;
    empty = false;
  }
  lines.push(current);
  return lines;
}

/**
 * @returns {{ text: string, links: Array<{ index: number, label: string, href: string }>, title: string|null }}
 */
export function render(html, { width = 76, color = false } = {}) {
  const paint = (code, text) => (color ? `${code}${text}${ANSI.reset}` : text);
  const links = [];
  const out = [];

  let buffer = '';
  let firstPrefix = '';
  let contPrefix = '';
  let heading = null;
  let listStack = [];
  let inPre = false;
  let preLines = [];
  let pendingHref = null;
  let linkText = '';
  let title = null;
  let inTitle = false;

  const blank = () => {
    if (out.length && out[out.length - 1] !== '') out.push('');
  };

  const flush = () => {
    if (buffer.trim()) out.push(...wrap(buffer, width, firstPrefix, contPrefix));
    buffer = '';
    firstPrefix = '';
    contPrefix = '';
  };

  const closeHeading = (char) => {
    flush();
    const last = out[out.length - 1];
    if (last) out.push(paint(ANSI.dim, char.repeat(Math.min(width, visibleWidth(last)))));
    heading = null;
  };

  const append = (text) => {
    if (pendingHref !== null) linkText += text;
    else buffer += text;
  };

  const tokens = String(html).matchAll(/<\/?([a-z0-9]+)((?:\s[^>]*)?)>|([^<]+)/gi);

  for (const token of tokens) {
    const [raw, tagName, attrText = '', text] = token;

    if (text !== undefined) {
      const decoded = decodeEntities(text);
      if (inPre) preLines.push(decoded);
      else if (inTitle) title = (title ?? '') + decoded.trim();
      else if (decoded.trim() || buffer) append(decoded.replace(/\s+/g, ' '));
      continue;
    }

    const tag = tagName.toLowerCase();
    const closing = raw.startsWith('</');
    const attrs = parseAttrs(attrText);

    switch (tag) {
      case 'title':
        inTitle = !closing;
        break;

      case 'h1':
      case 'h2':
      case 'h3':
        if (closing) {
          closeHeading(tag === 'h1' ? '═' : tag === 'h2' ? '─' : '·');
        } else {
          flush();
          blank();
          heading = tag;
          buffer = '';
          firstPrefix = tag === 'h3' ? '  ' : '';
          contPrefix = firstPrefix;
        }
        break;

      case 'p':
      case 'div':
        flush();
        if (!closing) blank();
        break;

      case 'blockquote':
        flush();
        if (!closing) {
          blank();
          firstPrefix = paint(ANSI.dim, '  │ ');
          contPrefix = firstPrefix;
        }
        break;

      case 'ul':
      case 'ol':
        flush();
        if (closing) listStack.pop();
        else {
          blank();
          listStack.push({ kind: tag, count: 0 });
        }
        break;

      case 'li': {
        flush();
        if (closing) break;
        const list = listStack[listStack.length - 1] ?? { kind: 'ul', count: 0 };
        list.count++;
        const indent = '  '.repeat(Math.max(1, listStack.length));
        const marker = list.kind === 'ol' ? `${list.count}. ` : '• ';
        firstPrefix = indent + marker;
        contPrefix = ' '.repeat(visibleWidth(firstPrefix));
        break;
      }

      case 'a':
        if (closing) {
          if (pendingHref !== null) {
            links.push({ index: links.length + 1, label: linkText.trim(), href: pendingHref });
            buffer += `${paint(ANSI.cyan, linkText.trim())}${paint(ANSI.yellow, `[${links.length}]`)}`;
            pendingHref = null;
            linkText = '';
          }
        } else {
          pendingHref = attrs.href ?? '';
          linkText = '';
        }
        break;

      case 'b':
      case 'strong':
        if (color) append(closing ? ANSI.reset : ANSI.bold);
        break;

      case 'i':
      case 'em':
        if (color) append(closing ? ANSI.reset : ANSI.italic);
        break;

      case 'small':
      case 'code':
        if (color) append(closing ? ANSI.reset : ANSI.dim);
        break;

      case 'br': {
        // A line break inside a list item keeps the item's hanging indent.
        const keep = contPrefix;
        flush();
        firstPrefix = keep;
        contPrefix = keep;
        break;
      }

      case 'hr':
        flush();
        blank();
        out.push(paint(ANSI.dim, '─'.repeat(width)));
        out.push('');
        break;

      case 'pre':
        if (closing) {
          inPre = false;
          blank();
          const body = preLines.join('').replace(/^\n+|\n+$/g, '');
          for (const line of body.split('\n')) out.push(`    ${paint(ANSI.green, line)}`);
          out.push('');
          preLines = [];
        } else {
          flush();
          inPre = true;
          preLines = [];
        }
        break;

      default:
        break;
    }

    if (heading && !closing && (tag === 'h1' || tag === 'h2' || tag === 'h3') && color) {
      buffer += ANSI.bold;
    }
  }

  flush();

  while (out.length && out[out.length - 1] === '') out.pop();
  while (out.length && out[0] === '') out.shift();

  return { text: out.join('\n'), links, title };
}

function parseAttrs(text) {
  const attrs = {};
  for (const match of String(text).matchAll(/([a-z-]+)\s*=\s*"([^"]*)"/gi)) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2]);
  }
  return attrs;
}

/** Plain text of a page, used by the search engine's indexer. */
export function toText(html) {
  return decodeEntities(
    String(html)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();
}
