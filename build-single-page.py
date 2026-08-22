#!/usr/bin/env python3
"""Bundle the hub and all eight games into one self-contained HTML page.

The multi-file version is the source of truth; this flattens it for hosting
anywhere that serves a single file. Each game keeps its own markup, styles and
script — the styles are scoped so identically-named classes cannot collide, and
only one game is mounted in the DOM at a time so element ids cannot either.

    python3 build-single-page.py            -> dist/synthesis-camp-games.html
"""
import os, re, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
GAMES = ['constellation', 'constellation-3d', 'proxima', 'fish',
         'fire', 'art-for-all', 'hollywood', 'geobridge']

read = lambda *p: open(os.path.join(ROOT, *p), encoding='utf-8').read()

SCRIPT_RE = re.compile(r'<script\b[^>]*>.*?</script>', re.S)
STYLE_RE = re.compile(r'<style\b[^>]*>(.*?)</style>', re.S)
INLINE_JS_RE = re.compile(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', re.S)
BODY_RE = re.compile(r'<body[^>]*>(.*)</body>', re.S)


def scope_css(css, prefix):
    """Prefix every top-level rule's selectors, so two games can both style `.card`."""
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    out = []
    for chunk in css.split('}'):
        if '{' not in chunk:
            continue
        sel, body = chunk.split('{', 1)
        sel = ', '.join(f'{prefix} {s.strip()}' for s in sel.split(',') if s.strip())
        out.append(f'{sel} {{{body.rstrip()}\n}}')
    return '\n'.join(out)


def parts(path):
    html = read(path)
    css = '\n'.join(STYLE_RE.findall(html))
    js = '\n'.join(INLINE_JS_RE.findall(html))
    body = BODY_RE.search(html).group(1)
    body = STYLE_RE.sub('', SCRIPT_RE.sub('', body)).strip()
    return css, js, body


def main():
    theme = read('shared', 'theme.css')
    util = read('shared', 'util.js')

    hub_css, hub_js, hub_body = parts('index.html')
    # links out of the hub become routes rather than files
    hub_js = hub_js.replace("a.href = `games/${game.dir}/index.html`;", "a.href = `#/${game.dir}`;")

    css_blocks = [theme, scope_css(hub_css, '#hub')]
    markup, inits = {}, []
    for dir_ in GAMES:
        css, js, body = parts(os.path.join('games', dir_, 'index.html'))
        body = body.replace('href="../../index.html"', 'href="#/"')
        body = body.replace('href="../constellation/index.html"', 'href="#/constellation"')
        if css:
            css_blocks.append(scope_css(css, f'#view[data-game="{dir_}"]'))
        markup[dir_] = body
        inits.append(f'GAME_INIT[{dir_!r}] = function () {{\n{js}\n}};')

    views = '\n'.join(
        f'<template data-game="{d}">\n{markup[d]}\n</template>' for d in GAMES)

    page = f"""<title>Synthesis Camp Games</title>
<style>
{chr(10).join(css_blocks)}
</style>

<div id="hub">
{hub_body}
</div>

<div id="view" hidden></div>
{views}

<script>
{util}
</script>

<script>
// The hub: paints a thumbnail per card and wires each one to its route.
{hub_js}
</script>

<script>
// Each game's original inline script, re-runnable as an init function.
const GAME_INIT = {{}};
{chr(10).join(inits)}
</script>

<script>
(function () {{
  const hub = document.getElementById('hub');
  const view = document.getElementById('view');
  const templates = Object.fromEntries(
    [...document.querySelectorAll('template[data-game]')].map(t => [t.dataset.game, t]));

  // Games schedule AI turns with setTimeout. Leaving a game mid-turn would let one
  // fire against markup that is no longer in the document, so track and cancel them.
  let pending = [];
  const nativeSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = function (fn, ms) {{
    const id = nativeSetTimeout(fn, ms);
    pending.push(id);
    return id;
  }};
  function unmount() {{
    pending.forEach(clearTimeout);
    pending = [];
    view.innerHTML = '';
  }}

  function show() {{
    const name = location.hash.replace(/^#\\/?/, '');
    if (!name || !templates[name]) {{
      view.hidden = true;
      unmount();
      view.removeAttribute('data-game');
      hub.hidden = false;
      document.title = 'Synthesis Camp Games';
    }} else {{
      hub.hidden = true;
      unmount();
      view.dataset.game = name;
      view.appendChild(templates[name].content.cloneNode(true));
      view.hidden = false;
      GAME_INIT[name]();
      document.title = view.querySelector('.topbar h1').textContent + ' — Synthesis Camp Games';
    }}
    window.scrollTo(0, 0);
  }}

  window.addEventListener('hashchange', show);
  show();
}})();
</script>
"""
    os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
    out = os.path.join(ROOT, 'dist', 'synthesis-camp-games.html')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(page)
    print(f'{out}  {len(page) / 1024:.0f} KB')


if __name__ == '__main__':
    sys.exit(main())
