"""End-to-end checks for the page, driven by a real browser.

The far ends are stubbed by a local server rather than reached over the
internet, so the test can decide exactly how fast each one answers and then
assert that the ranking, the recommendation and the generated config all
follow from those measurements. It also covers the paths that only appear
when something is blocked, which is hard to arrange on a working connection.

The stub streams the download body at a set rate instead of releasing it in
one go, so the real timing code -- the part that decides whether a response
streamed or was buffered somewhere -- is exercised rather than bypassed.

    pip install playwright && python3 docs/browser.test.py

Set CHROME to a Chromium binary if Playwright cannot find one itself, and
SCREENSHOT to a path to save a full-page capture of a completed run.
"""

from __future__ import annotations

import datetime
import http.server
import os
import re
import socketserver
import ssl
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
CHROME = os.environ.get("CHROME")

# Round trip times to inject, in milliseconds. The order here is what the page
# is expected to discover; it deliberately is not the order they are listed in.
LATENCY = {
    "ap-northeast-1": 60,   # 日本
    "ap-southeast-1": 72,   # 新加坡 -- deliberately near Japan so the
                        #   tolerance window has a second candidate to
                        #   include, whatever speed the stub achieves
    "us-west-2": 150,       # 美國西岸
    "us-east-1": 190,       # 美國東岸
    "mx-central-1": 200,    # 墨西哥
    "ca-central-1": 215,    # 加拿大
    "eu-central-2": 250,    # 瑞士
    "eu-central-1": 260,    # 荷蘭、波蘭、羅馬尼亞 -- one endpoint, three countries
    "eu-north-1": 275,      # 挪威
}


def app_regions():
    """Read the country table out of the page.

    Parsing it rather than restating it means the test cannot quietly drift
    away from the list the page actually measures.
    """
    block = re.search(
        r"const REGIONS = \[(.*?)\n\];",
        (HERE / "index.html").read_text(encoding="utf-8"),
        re.S,
    ).group(1)
    found = []
    for line in block.splitlines():
        fields = re.search(
            r'key:\s*"([^"]+)".*?name:\s*"([^"]+)".*?city:\s*"([^"]+)".*?probe:\s*"([^"]+)"',
            line,
        )
        if fields:
            found.append({
                "key": fields.group(1), "name": fields.group(2),
                "city": fields.group(3), "probe": fields.group(4),
                "approx": "approx: true" in line,
            })
    if not found:
        raise SystemExit("could not read REGIONS out of index.html")
    return found


REGIONS = app_regions()
TARGET_MBPS = 40.0
TRACE_BODY = b"ip=203.0.113.42\nloc=TW\ncolo=TPE\nwarp=off\n"

failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    if not ok:
        failures.append(label)
    print(f"  [{'ok  ' if ok else 'FAIL'}] {label}{'  -- ' + detail if detail else ''}")


# ---------------------------------------------------------------------------
# the stub server
# ---------------------------------------------------------------------------

class StubHandler(http.server.SimpleHTTPRequestHandler):
    """Serves the page, plus stand-ins for the three remote endpoints."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def log_message(self, *args):  # keep the test output readable
        if os.environ.get("STUB_DEBUG"):
            print("    stub <-", self.path[:90], flush=True)

    def do_GET(self):  # noqa: N802 - name fixed by the base class
        path = urlparse(self.path).path
        query = parse_qs(urlparse(self.path).query)
        if path == "/stub/trace":
            return self._send(200, b"text/plain", TRACE_BODY)
        if path == "/stub/probe":
            time.sleep(LATENCY.get(query.get("region", [""])[0], 100) / 1000)
            return self._send(404, b"text/plain", b"not found")
        if path == "/stub/down":
            return self._stream(int(query.get("bytes", ["1000000"])[0]))
        return super().do_GET()

    def _send(self, status: int, content_type: bytes, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type.decode())
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # The browser judges CORS by the URL the page asked for, not by the one
        # the request was rewritten to, so these still count as cross-origin.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _stream(self, size: int) -> None:
        """Write the body in paced chunks, like a real server would."""
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        chunk = 64 * 1024
        per_chunk = (chunk * 8) / (TARGET_MBPS * 1e6)
        sent = 0
        started = time.monotonic()
        while sent < size:
            this = min(chunk, size - sent)
            try:
                self.wfile.write(b"\x00" * this)
            except (BrokenPipeError, ConnectionResetError):
                return
            sent += this
            # Sleep only as far as we are ahead of the target rate.
            ahead = (sent * 8) / (TARGET_MBPS * 1e6) - (time.monotonic() - started)
            if ahead > 0:
                time.sleep(min(ahead, per_chunk * 4))


class ThreadedServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass


def self_signed_certificate(directory: Path) -> tuple[Path, Path]:
    """A throwaway certificate for 127.0.0.1.

    The stub has to speak HTTPS: a request can only be redirected to a URL
    with the same protocol, and the page asks for https.
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")])
    now = datetime.datetime.now(datetime.timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.IPAddress(__import__("ipaddress").IPv4Address("127.0.0.1"))]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    certificate_path = directory / "stub.crt"
    key_path = directory / "stub.key"
    certificate_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    return certificate_path, key_path


def serve(directory: Path) -> tuple[ThreadedServer, int]:
    """Serve over HTTPS, which is what request rewriting requires."""
    certificate_path, key_path = self_signed_certificate(directory)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate_path, key_path)
    server = ThreadedServer(("127.0.0.1", 0), StubHandler)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def serve_plain() -> tuple[ThreadedServer, int]:
    """Serve over plain HTTP on loopback, which browsers treat as secure.

    The app shell checks need this: a service worker refuses to register on a
    page whose certificate the browser does not trust, and the throwaway one
    above never will be.
    """
    server = ThreadedServer(("127.0.0.1", 0), StubHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


# ---------------------------------------------------------------------------
# routing the page's requests at the stub
# ---------------------------------------------------------------------------

def install_routes(page, base: str, *, trace=True, speed=True, probes=True):
    """Point the page's outbound requests at the stub, or block them."""

    def on_trace(route):
        route.abort() if not trace else route.continue_(url=base + "/stub/trace")

    def on_down(route):
        if not speed:
            return route.abort()
        match = re.search(r"bytes=(\d+)", route.request.url)
        size = match.group(1) if match else "1000000"
        route.continue_(url=f"{base}/stub/down?bytes={size}")

    def on_probe(route):
        if not probes:
            return route.abort()
        found = re.search(r"s3\.([a-z0-9-]+)\.amazonaws\.com", route.request.url)
        region = found.group(1) if found else ""
        route.continue_(url=f"{base}/stub/probe?region={region}&t={time.time()}")

    page.route("**/cdn-cgi/trace*", on_trace)
    page.route("**/__down*", on_down)
    page.route("**s3.*.amazonaws.com/**", on_probe)


def wait_for_finish(page, timeout: float = 180) -> str:
    """Wait inside the browser, not by polling from here.

    Polling over the driver connection competes with the request handlers
    that serve the stub, which delays every intercepted request and swamps
    the very latencies this test is trying to measure.
    """
    try:
        page.wait_for_function(
            "['done', 'failed'].includes(document.body.dataset.state || '')",
            timeout=timeout * 1000,
        )
    except Exception:
        return "timeout"
    return page.evaluate("document.body.dataset.state")


def region_rows(page):
    return page.evaluate(
        """() => [...document.querySelectorAll('#regions li')].map(li => ({
             name: li.querySelector('.rname').textContent.trim(),
             meta: li.querySelector('.rmeta').textContent.trim(),
             ms: li.querySelector('.rms').firstChild.textContent.trim(),
             cls: li.className,
           }))"""
    )


# ---------------------------------------------------------------------------
# scenarios
# ---------------------------------------------------------------------------

def scenario_normal(browser, base):
    print("\nnormal run: everything reachable")
    page = browser.new_page(viewport={"width": 390, "height": 844},
                            ignore_https_errors=True)
    install_routes(page, base)
    page.goto(base + "/index.html", wait_until="load")
    state = wait_for_finish(page)

    check("run completed", state == "done", state)
    check("public IP taken from the trace", page.inner_text("#f-ip") == "203.0.113.42")
    check("exit country decoded", "台灣" in page.inner_text("#f-loc"),
          page.inner_text("#f-loc"))
    check("edge node shown", page.inner_text("#f-colo") == "TPE")

    speed = page.inner_text("#f-speed")
    measured_speed = float(speed) if speed not in ("—", "") else 0.0
    check("download speed is close to the rate the stub served at",
          TARGET_MBPS * 0.6 <= measured_speed <= TARGET_MBPS * 1.4,
          f"{speed} Mbps against {TARGET_MBPS:g}")

    rows = region_rows(page)
    check("every country rendered", len(rows) == len(REGIONS), str(len(rows)))
    answered = [row for row in rows if row["ms"] != "無回應"]
    check("every country answered", len(answered) == len(REGIONS), str(len(answered)))

    values = [int(row["ms"]) for row in answered]
    check("listed fastest first", values == sorted(values), str(values))
    by_latency = sorted(REGIONS, key=lambda r: LATENCY[r["probe"]])
    check("fastest country is the one made fastest",
          by_latency[0]["name"] in rows[0]["name"], rows[0]["name"])
    check("slowest country is the one made slowest",
          by_latency[-1]["name"] in rows[-1]["name"], rows[-1]["name"])

    # Any fixed overhead in the harness shifts every reading equally, so
    # compare the spacing between regions rather than absolute numbers.
    # One reading per country, so a shared endpoint contributes its value
    # once for each country that borrows it.
    injected = sorted(LATENCY[region["probe"]] for region in REGIONS)
    gaps = [value - values[0] for value in values]
    expected = [value - injected[0] for value in injected]
    check("spacing between countries matches what was injected",
          all(abs(gaps[i] - expected[i]) < 40 for i in range(len(REGIONS))),
          f"{gaps} against {expected}")

    picked = [row for row in rows if "pick" in row["cls"]]
    check("exactly one region is recommended", len(picked) == 1)
    check("the recommendation is the fastest",
          bool(picked) and by_latency[0]["name"] in picked[0]["name"])

    # tolerance(40 Mbps) is 42 ms, so only regions within best + 42 qualify.
    usable = [row for row in rows if "pick" in row["cls"] or "ok" in row["cls"]]
    window = 10 + min(measured_speed, 100) * 0.8
    check("usable set follows the tolerance window",
          all(int(row["ms"]) <= values[0] + window + 25 for row in usable),
          f"{len(usable)} usable, window ±{window:.0f} ms")
    check("more than one country qualifies at this speed", len(usable) > 1,
          f"{len(usable)} usable")

    advice = page.inner_text("#advice-body")
    check("advice names the recommended country", by_latency[0]["name"] in advice)
    check("advice explains the window", "ms" in advice and "以內" in advice)

    # The config sits inside a collapsed <details>, so read the DOM text
    # rather than what happens to be painted.
    config = page.text_content("#config")
    check("config generated for the pick", by_latency[0]["key"] + ".你的網域" in config,
          config.splitlines()[0])

    action = page.inner_text("#action")
    check("the actionable step names the country",
          by_latency[0]["name"] in action, action)

    # Countries with no endpoint of their own share a neighbour's reading.
    shared = {}
    for row in rows:
        for region in REGIONS:
            if region["name"] in row["name"]:
                shared.setdefault(region["probe"], []).append(row["ms"])
    for probe, readings in shared.items():
        if len(readings) > 1:
            check(f"countries sharing {probe} report the same latency",
                  len(set(readings)) == 1, str(readings))
    approx_names = [r["name"] for r in REGIONS if r["approx"]]
    marked = [row for row in rows if "≈" in row["meta"]]
    check("borrowed readings are marked approximate",
          len(marked) == len(approx_names),
          f"{len(marked)} marked, {len(approx_names)} expected")
    check("config is a client config",
          "AllowedIPs" in config and "0.0.0.0/0" in config)
    check("config carries no real private key", "<你的私鑰>" in config)

    shot = os.environ.get("SCREENSHOT")
    if shot:
        page.screenshot(path=shot, full_page=True)
    page.close()


def scenario_speed_blocked(browser, base):
    print("\ndegraded run: speed test and trace blocked, probes still work")
    page = browser.new_page(viewport={"width": 390, "height": 844},
                            ignore_https_errors=True)
    install_routes(page, base, trace=False, speed=False)
    page.goto(base + "/index.html", wait_until="load")
    state = wait_for_finish(page)

    check("run still completes", state == "done", state)
    check("speed shown as unavailable", page.inner_text("#f-speed") == "—")
    check("trace failure reported", "逾時" in page.inner_text("#f-ip"),
          page.inner_text("#f-ip"))
    rows = region_rows(page)
    check("regions still measured", all(row["ms"] != "無回應" for row in rows))
    check("a country is still recommended",
          len([row for row in rows if "pick" in row["cls"]]) == 1)
    advice = page.inner_text("#advice-body")
    check("advice says the speed test could not be reached", "測速服務連不上" in advice)
    usable = [row for row in rows if "pick" in row["cls"] or "ok" in row["cls"]]
    check("falls back to a cautious window", len(usable) <= 2, f"{len(usable)} usable")
    check("config still generated", "AllowedIPs" in page.text_content("#config"))
    page.close()


def scenario_all_blocked(browser, base):
    print("\noffline run: nothing reachable")
    page = browser.new_page(viewport={"width": 390, "height": 844},
                            ignore_https_errors=True)
    install_routes(page, base, trace=False, speed=False, probes=False)
    page.goto(base + "/index.html", wait_until="load")
    state = wait_for_finish(page)

    check("reports failure rather than hanging", state == "failed", state)
    rows = region_rows(page)
    check("every region marked unreachable", all(row["ms"] == "無回應" for row in rows))
    check("no country is recommended",
          not [row for row in rows if "pick" in row["cls"]])
    check("the page says what happened", "失敗" in page.inner_text("#status"),
          page.inner_text("#status"))
    page.close()


IPHONE = {"viewport": {"width": 390, "height": 844}, "has_touch": True,
          "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
                        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"}
# iPadOS reports itself as a Mac, so the touch screen is what gives it away.
IPAD = {"viewport": {"width": 820, "height": 1180}, "has_touch": True,
        "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"}
IPAD_LANDSCAPE = dict(IPAD, viewport={"width": 1180, "height": 820})


def scenario_devices(browser, base, stub_base):
    """The page has to read correctly on a phone and on a tablet."""
    print("\ndevices: phone and iPad")
    for label, device, expected_hint, columns in [
        ("iPhone portrait", IPHONE, "下方工具列", 1),
        ("iPad portrait", IPAD, "右上角", 2),
        ("iPad landscape", IPAD_LANDSCAPE, "右上角", 2),
    ]:
        page = browser.new_page(ignore_https_errors=True, **device)
        install_routes(page, stub_base)
        page.goto(base + "/index.html", wait_until="load")

        hint = page.inner_text("#share-where")
        check(f"{label}: points at the right share button",
              expected_hint in hint,
              f"{hint} (maxTouchPoints={page.evaluate('navigator.maxTouchPoints')})")
        check(f"{label}: no sideways scrolling",
              page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
              f"content {page.evaluate('document.documentElement.scrollWidth')}px "
              f"in {device['viewport']['width']}px")
        actual = page.evaluate(
            """() => {
                 const grid = document.querySelector('.side-by-side');
                 return getComputedStyle(grid).gridTemplateColumns.split(' ').length;
               }"""
        )
        check(f"{label}: uses {columns} column(s) for the summary cards",
              actual == columns, f"{actual}")
        check(f"{label}: the wide config block scrolls inside its own box",
              page.evaluate("""() => {
                  const pre = document.querySelector('pre');
                  return getComputedStyle(pre).overflowX === 'auto';
              }"""))
        page.close()


def scenario_shell(browser, base, stub_base):
    print("\napp shell: home screen support")
    page = browser.new_page(viewport={"width": 390, "height": 844},
                            ignore_https_errors=True)
    install_routes(page, stub_base)
    page.goto(base + "/index.html", wait_until="load")

    check("manifest linked",
          page.locator('link[rel="manifest"]').count() == 1)
    check("apple touch icon linked",
          page.locator('link[rel="apple-touch-icon"]').count() == 1)
    check("iOS full screen enabled",
          page.locator('meta[name="apple-mobile-web-app-capable"][content="yes"]').count() == 1)
    check("install hint shown when not launched from the home screen",
          page.locator("#install.show").count() == 1)
    check("service worker registers",
          page.evaluate("navigator.serviceWorker.getRegistrations().then(r => r.length > 0)"))
    check("page does not scroll sideways on a phone",
          page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
          str(page.evaluate("document.documentElement.scrollWidth")))
    page.close()


def main() -> int:
    scratch = tempfile.TemporaryDirectory()
    server, port = serve(Path(scratch.name))
    plain, plain_port = serve_plain()
    base = f"https://127.0.0.1:{port}"
    shell_base = f"http://127.0.0.1:{plain_port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                **({"executable_path": CHROME} if CHROME else {})
            )
            try:
                scenario_normal(browser, base)
                scenario_speed_blocked(browser, base)
                scenario_all_blocked(browser, base)
                scenario_shell(browser, shell_base, base)
                scenario_devices(browser, shell_base, base)
            finally:
                browser.close()
    finally:
        server.shutdown()
        plain.shutdown()
        scratch.cleanup()

    print()
    print("all browser checks passed" if not failures
          else f"{len(failures)} check(s) failed: {', '.join(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
