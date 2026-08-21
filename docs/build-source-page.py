"""Renders the tunnel's source into a page that can be read on a phone.

The code is highlighted with the standard library's own tokenizer rather
than a regex, so what the page colours is exactly what Python sees. It is
generated from pyvpn/*.py at build time, which means the page cannot drift
away from the code it claims to show.

    python3 docs/build-source-page.py            # writes docs/server.html
"""

from __future__ import annotations

import html
import io
import keyword
import tokenize
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent / "pyvpn"
OUTPUT = HERE / "server.html"

# Ordered so the page reads as an explanation rather than a directory listing:
# the way in first, then the cryptography, then the plumbing.
ORDER = [
    ("cli.py", "命令列介面", "解析子指令：產生金鑰、建立設定、啟動伺服器或客戶端。"),
    ("server.py", "伺服器", "開 TUN、開 UDP、設定 NAT，然後把事件迴圈跑起來。"),
    ("client.py", "客戶端", "開 TUN、把預設路由改道進隧道、連上伺服器。"),
    ("device.py", "事件迴圈", "整份程式的心臟：在 TUN 與 UDP 之間搬封包，加解密都在這裡發生。"),
    ("noise.py", "握手", "Noise_IKpsk2 交握，兩個封包就談好一組全新的會談金鑰。"),
    ("crypto.py", "密碼學基元", "X25519、ChaCha20-Poly1305、BLAKE2s，以及金鑰衍生。"),
    ("messages.py", "封包格式", "四種訊息的位元組佈局與解析。"),
    ("replay.py", "重放防護", "滑動視窗，每個計數器只接受一次。"),
    ("peer.py", "對端狀態", "金鑰輪替、保活、逾時，以及每個對端的統計。"),
    ("tun.py", "TUN 裝置", "用 ioctl 建立虛擬網卡並設定位址，不依賴 ip 指令。"),
    ("routing.py", "路由", "把預設路由導進隧道，同時保留通往伺服器本身的路。"),
    ("nat.py", "NAT", "設定 iptables，讓客戶端的流量能真的出去網際網路。"),
    ("ip.py", "IP 封包", "讀取 IPv4 標頭的來源與目的位址。"),
    ("resolver.py", "DNS", "解析伺服器主機名稱，並在需要時接管 resolv.conf。"),
    ("config.py", "設定檔", "解析 INI 格式的設定，並在錯誤時指出行號。"),
    ("selftest.py", "自我測試", "端對端驗證：握手、加密、隧道往返、重放拒絕。"),
    ("__init__.py", "套件", "版本與公開名稱。"),
    ("__main__.py", "進入點", "python3 -m pyvpn 會執行到這裡。"),
]

BUILTINS = {
    "True", "False", "None", "self", "cls", "int", "str", "bytes", "float",
    "bool", "list", "dict", "set", "tuple", "len", "range", "enumerate",
    "print", "open", "isinstance", "super", "type", "min", "max", "sum",
    "sorted", "any", "all", "bytearray", "memoryview", "hex", "repr",
}


def highlight(source: str) -> str:
    """Return the source as HTML, one <span class="l"> per line.

    No span is allowed to straddle a newline: a docstring is emitted as one
    span per line it covers. That keeps every line independently wrappable,
    which is what lets the gutter numbers line up.
    """
    lines = source.splitlines(keepends=True)
    starts, offset = [], 0
    for line in lines:
        starts.append(offset)
        offset += len(line)

    spans: list[tuple[int, int, str]] = []
    previous = ""
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except (tokenize.TokenError, IndentationError):
        tokens = []

    for token in tokens:
        kind = ""
        if token.type == tokenize.COMMENT:
            kind = "c"
        elif token.type == tokenize.STRING:
            kind = "s"
        elif token.type == tokenize.NUMBER:
            kind = "n"
        elif token.type == tokenize.NAME:
            if keyword.iskeyword(token.string):
                kind = "k"
            elif previous in ("def", "class"):
                kind = "f"
            elif token.string in BUILTINS:
                kind = "b"
        elif token.type == tokenize.OP:
            kind = "o"
        if token.type == tokenize.NAME:
            previous = token.string
        elif token.type not in (tokenize.NL, tokenize.NEWLINE, tokenize.INDENT):
            previous = ""

        if kind:
            begin = starts[token.start[0] - 1] + token.start[1]
            end = starts[token.end[0] - 1] + token.end[1]
            spans.append((begin, end, kind))

    # Walk the text once, emitting plain runs between the coloured ones.
    pieces: list[tuple[str, str]] = []
    cursor = 0
    for begin, end, kind in spans:
        if begin < cursor:
            continue
        if begin > cursor:
            pieces.append((source[cursor:begin], ""))
        pieces.append((source[begin:end], kind))
        cursor = end
    pieces.append((source[cursor:], ""))

    # Break every piece at newlines so no span crosses one.
    out: list[str] = []
    current: list[str] = []
    for text, kind in pieces:
        parts = text.split("\n")
        for index, part in enumerate(parts):
            if index:
                out.append('<span class="l">' + "".join(current) + "</span>\n")
                current = []
            if part:
                escaped = html.escape(part)
                current.append(f'<span class="{kind}">{escaped}</span>' if kind else escaped)
    if current:
        out.append('<span class="l">' + "".join(current) + "</span>\n")
    return "".join(out)


def module_sections() -> tuple[str, int]:
    parts, total = [], 0
    for name, title, blurb in ORDER:
        path = PACKAGE / name
        if not path.exists():
            continue
        source = path.read_text(encoding="utf-8")
        count = source.count("\n") + (0 if source.endswith("\n") else 1)
        total += count
        parts.append(
            "<details class=\"mod\">\n"
            f"  <summary><span class=\"mname\">{html.escape(name)}</span>"
            f"<span class=\"mtitle\">{html.escape(title)}</span>"
            f"<span class=\"mlines\">{count} 行</span></summary>\n"
            f"  <p class=\"blurb\">{html.escape(blurb)}</p>\n"
            f"  <pre class=\"code\"><code>{highlight(source)}</code></pre>\n"
            "</details>"
        )
    return "\n".join(parts), total


PAGE = """<title>VPN 伺服器原始碼</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<style>
:root {
  --bg: #0b1020; --bg-raised: #141b31; --bg-sunken: #070b16;
  --line: #263150; --text: #eaf0ff; --muted: #93a1c4;
  --accent: #5ee1a6; --warn: #ffcc66;
  --c-kw: #ff9ecd; --c-str: #a5e887; --c-com: #6c7a9c;
  --c-num: #ffcc66; --c-fn: #7cc4ff; --c-bi: #c8a2ff; --c-op: #b6c2e2;
  --radius: 16px;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f4f6fc; --bg-raised: #ffffff; --bg-sunken: #eef1f9;
    --line: #d3dae9; --text: #131a2c; --muted: #5a6785;
    --accent: #0e9c68;
    --c-kw: #b0116f; --c-str: #197a2e; --c-com: #7a86a3;
    --c-num: #9a6200; --c-fn: #1064b8; --c-bi: #6b34c9; --c-op: #4a5673;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: max(16px, env(safe-area-inset-top)) 16px calc(40px + env(safe-area-inset-bottom));
  background: var(--bg); color: var(--text);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Noto Sans TC",
        "PingFang TC", "Microsoft JhengHei", sans-serif;
  -webkit-font-smoothing: antialiased;
  max-width: 680px; margin-inline: auto; overflow-x: hidden;
}
@media (min-width: 760px) { body { max-width: 900px; padding-inline: 24px; } }
a { color: var(--accent); }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
h2 { font-size: 1.05rem; margin: 0 0 10px; }
.sub { color: var(--muted); margin: 0 0 22px; font-size: 0.92rem; }
.card {
  background: var(--bg-raised); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 18px; margin-bottom: 14px;
}
.note { color: var(--muted); font-size: 0.9rem; margin: 0; }
.warn {
  border-left: 3px solid var(--warn); padding-left: 12px;
  color: var(--muted); font-size: 0.9rem; margin: 12px 0 0;
}
/* the packet's journey: a column on a phone, a row where there is width */
.flow { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 0; }
.flow div {
  background: var(--bg-sunken); border: 1px solid var(--line);
  border-radius: 10px; padding: 9px 12px; font-size: 0.86rem;
}
.flow div b { color: var(--accent); font-weight: 600; }
.flow span { color: var(--muted); display: block; text-align: center; font-size: 0.8rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.86rem; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; }
td code { color: var(--accent); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.mod { border-top: 1px solid var(--line); }
.mod:first-of-type { border-top: 0; }
.mod summary {
  cursor: pointer; padding: 12px 2px; display: flex; gap: 10px;
  align-items: baseline; flex-wrap: wrap; list-style: none;
}
.mod summary::-webkit-details-marker { display: none; }
.mod summary::before {
  content: "+"; color: var(--muted); font-family: ui-monospace, monospace;
  width: 1em; flex: none;
}
.mod[open] summary::before { content: "\\2212"; }
.mname { font-family: ui-monospace, monospace; font-size: 0.9rem; color: var(--accent); }
.mtitle { font-weight: 600; font-size: 0.94rem; }
.mlines { color: var(--muted); font-size: 0.8rem; margin-left: auto; }
.blurb { color: var(--muted); font-size: 0.88rem; margin: 0 0 10px 1.6em; }
pre.code {
  background: var(--bg-sunken); border: 1px solid var(--line);
  border-radius: 12px; margin: 0 0 14px;
  padding: 12px 12px 12px 0;
  overflow-x: auto;                 /* the code scrolls, never the page */
  -webkit-overflow-scrolling: touch;
  font-size: 12px; line-height: 1.5;
  counter-reset: line;
}
pre.code code { white-space: pre; display: block; }
.l { display: block; padding-left: 3.6em; text-indent: -0.1em; }
.l::before {
  counter-increment: line; content: counter(line);
  display: inline-block; width: 3em; margin-left: -3.6em; padding-right: 0.6em;
  text-align: right; color: var(--c-com); opacity: 0.65; user-select: none;
}
.k { color: var(--c-kw); } .s { color: var(--c-str); } .c { color: var(--c-com); font-style: italic; }
.n { color: var(--c-num); } .f { color: var(--c-fn); } .b { color: var(--c-bi); } .o { color: var(--c-op); }
</style>

<h1>VPN 伺服器原始碼</h1>
<p class="sub">{total} 行 · 加密的 IP 隧道 · <a href="./">← 回到節點建議</a></p>

<section class="card">
  <h2>這是什麼</h2>
  <p class="note">一個完整的 VPN 實作：自己談金鑰、自己加密、自己建立隧道介面，
  並把客戶端的流量透過 NAT 送到真正的網際網路。加密用 X25519 交換金鑰、
  ChaCha20-Poly1305 加密、BLAKE2s 雜湊 —— 與 WireGuard 相同的組合，
  但封包格式是自己的，兩者不能互通。</p>
  <p class="warn">這份程式跑在一台 Linux 機器上，不是 iPad。iOS 不能執行
  Python，也不允許背景的網路服務，所以這一頁只能讀，不能執行。</p>
</section>

<section class="card">
  <h2>一個封包怎麼走</h2>
  <div class="flow">
    <div><b>你的程式</b> 送出一個往 example.com 的封包</div>
    <span>↓</span>
    <div><b>TUN 介面</b> 作業系統把它交給我們，而不是送上網卡</div>
    <span>↓</span>
    <div><b>加密</b> ChaCha20-Poly1305，附上計數器防重放</div>
    <span>↓</span>
    <div><b>UDP</b> 送往伺服器。中途任何人只看得到亂數</div>
    <span>↓</span>
    <div><b>伺服器解密</b> 並檢查來源位址是否為該對端所允許</div>
    <span>↓</span>
    <div><b>NAT</b> 換上伺服器的位址，送往真正的網際網路</div>
  </div>
  <p class="note" style="margin-top:12px">回程完全相反。對 example.com 來說，
  來訪的是伺服器，不是你。</p>
</section>

<section class="card">
  <h2>握手：兩個封包</h2>
  <p class="note">Noise_IKpsk2 交握。客戶端送一個封包、伺服器回一個，
  雙方就得到一組全新的會談金鑰。每次握手都用臨時金鑰，所以就算日後長期
  私鑰外洩，也解不開先前錄下的流量 —— 這叫前向保密。</p>
  <table>
    <tr><th>訊息</th><th>大小</th><th>內容</th></tr>
    <tr><td><code>initiation</code></td><td>148 B</td><td>臨時公鑰、加密過的身分、時間戳</td></tr>
    <tr><td><code>response</code></td><td>92 B</td><td>臨時公鑰、確認標籤</td></tr>
    <tr><td><code>data</code></td><td>16 B + 酬載 + 16 B</td><td>加密後的 IP 封包</td></tr>
  </table>
  <p class="note" style="margin-top:12px">身分是<strong>加密</strong>傳送的，
  所以旁觀者看不出是誰在連線。時間戳必須嚴格遞增，錄下來的握手重送會被拒絕。</p>
</section>

<section class="card">
  <h2>原始碼</h2>
  <p class="note" style="margin-bottom:12px">點模組名稱展開。程式碼是從
  <code>pyvpn/*.py</code> 直接產生的，所以這裡看到的就是實際執行的內容。</p>
{modules}
</section>

<p class="note" style="text-align:center">
  在 Linux 機器上執行：<code>sudo python3 pyvpn-server.pyz server -c server.conf</code>
</p>
"""


def main() -> int:
    modules, total = module_sections()
    # Plain substitution, not str.format: the template is mostly CSS, and
    # every brace in it would have to be doubled otherwise.
    page = PAGE.replace("{total}", str(total)).replace("{modules}", modules)
    OUTPUT.write_text(page, encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(HERE.parent)} ({OUTPUT.stat().st_size:,} bytes, {total} lines of source)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
