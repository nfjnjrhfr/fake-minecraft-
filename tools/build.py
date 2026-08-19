#!/usr/bin/env python3
"""把所有原始檔打包成單一可離線遊玩的 HTML：開玉.html"""
import re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
html = (root / 'index.html').read_text(encoding='utf-8')
css = (root / 'style.css').read_text(encoding='utf-8')
js = [(root / 'js' / f).read_text(encoding='utf-8')
      for f in ['data.js', 'jade.js', 'mine.js', 'fx.js', 'raid.js', 'game.js', 'ui.js']]

html = html.replace('<link rel="stylesheet" href="style.css">',
                    '<style>\n' + css + '\n</style>')
html = re.sub(r'\n?<script src="js/[a-z]+\.js"></script>', '', html)
html = html.replace('</body>', '<script>\n' + '\n'.join(js) + '\n</script>\n</body>')
out = root / '開玉.html'
out.write_text(html, encoding='utf-8')
print('打包完成 →', out.name, f'{out.stat().st_size/1024:.0f} KB')

# Artifact 版：只留 body 內容（發佈端會補 doctype/head/body 骨架）
m = re.search(r'<body>(.*)</body>', html, re.S)
body = m.group(1)
css_tag = re.search(r'<style>.*?</style>', html, re.S).group(0)
art = '<title>開玉</title>\n' + css_tag + '\n' + body
(root / 'artifact.html').write_text(art, encoding='utf-8')
print('Artifact 版 → artifact.html', f'{len(art.encode())/1024:.0f} KB')
