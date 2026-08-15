"""網頁版聊天：HTTP API + Server-Sent Events。

用法::

    python -m chatapp web --host 0.0.0.0 --port 8000

瀏覽器打開 http://<主機>:<埠號>/ 即可使用，不需安裝任何東西。

架構：沿用 :class:`chatapp.server.ChatServer` 的房間／廣播／私訊核心，
把「socket 連線」換成「HTTP 會話」——每個瀏覽器分頁對應一個
:class:`WebClient`，它的 ``send()`` 不寫 socket，而是把訊息丟進佇列，
由 ``GET /events`` 的 SSE 串流推給瀏覽器。

API：
* ``GET  /``                 聊天頁面
* ``POST /api/login``        ``{"nick": str}`` → ``{"token": str}``
* ``POST /api/send``         ``{"token": str, "message": {...}}``（message 格式同 protocol）
* ``GET  /events?token=...`` SSE 事件串流，每則事件是一行 protocol JSON

選 SSE 而不選 WebSocket 是因為標準函式庫就能做到，維持零依賴。
"""

from __future__ import annotations

import argparse
import json
import logging
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Empty, Queue
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import protocol
from .server import ChatServer

log = logging.getLogger("chatapp.web")

MAX_BODY_BYTES = 64 * 1024
#: SSE 斷線後保留會話多久（秒）；瀏覽器重整或短暫斷網可無縫接回。
SESSION_LINGER = 60.0
#: SSE 每隔幾秒送一次 keep-alive 註解，避免中間的 proxy 把閒置連線砍掉。
PING_INTERVAL = 15.0

_WEBUI_PATH = Path(__file__).with_name("webui.html")


class WebClient:
    """以佇列代替 socket 的客戶端，介面與 server.Client 相同。"""

    def __init__(self, token: str) -> None:
        self.token = token
        self.nick: str | None = None
        self.rooms: set[str] = set()
        self.current_room: str | None = None
        self.queue: Queue[dict[str, Any] | None] = Queue(maxsize=1000)
        self.last_seen = time.monotonic()
        #: 世代編號：新的 SSE 連線會 +1，讓舊連線（如殘留的重整前分頁）自行退出
        self.sse_generation = 0
        self.sse_active = False
        self._closed = False

    @property
    def name(self) -> str:
        return self.nick or f"web-{self.token[:6]}"

    def send(self, message: dict[str, Any]) -> bool:
        if self._closed:
            return False
        try:
            self.queue.put_nowait(message)
            return True
        except Exception:
            return False  # 佇列爆了：這個瀏覽器早就不讀了，略過即可

    def system(self, text: str) -> None:
        self.send({"type": protocol.SYSTEM, "text": text, "ts": time.time()})

    def error(self, text: str) -> None:
        self.send({"type": protocol.ERROR, "text": text, "ts": time.time()})

    def close(self) -> None:
        self._closed = True
        try:
            self.queue.put_nowait(None)  # 喚醒 SSE 迴圈讓它結束
        except Exception:
            pass

    @property
    def closed(self) -> bool:
        return self._closed


class WebChatApp:
    """把 ChatServer 核心包成網頁應用。"""

    def __init__(self) -> None:
        self.core = ChatServer()  # 只用它的房間邏輯，不呼叫 start()
        self._sessions: dict[str, WebClient] = {}
        self._lock = threading.Lock()
        self._reaper = threading.Thread(target=self._reap_loop, daemon=True,
                                        name="session-reaper")
        self._reaper.start()

    # ------------------------------------------------------------------
    def login(self, nick: str) -> tuple[str | None, dict[str, Any]]:
        """建立會話並登入；回傳 (token, 第一則回覆訊息)。失敗時 token 為 None。"""
        token = secrets.token_urlsafe(24)
        client = WebClient(token)
        with self.core._lock:
            self.core._clients.add(client)  # type: ignore[arg-type]
        self.core._handle_login(client, {"type": protocol.LOGIN, "nick": nick})  # type: ignore[arg-type]

        # 成功的話 nick 會被設定；失敗則佇列裡只有一則 ERROR。
        # 不從佇列拿 WELCOME 出來檢查，才不會打亂 SSE 事件的順序。
        if client.nick is None:
            with self.core._lock:
                self.core._clients.discard(client)  # type: ignore[arg-type]
            error = client.queue.get_nowait()
            assert error is not None
            return None, error
        with self._lock:
            self._sessions[token] = client
        log.info("網頁登入：%s", client.name)
        return token, {"nick": client.nick, "room": client.current_room}

    def get_client(self, token: str) -> WebClient | None:
        with self._lock:
            client = self._sessions.get(token)
        if client is not None and not client.closed:
            client.last_seen = time.monotonic()
            return client
        return None

    def dispatch(self, client: WebClient, message: dict[str, Any]) -> None:
        keep = self.core._dispatch(client, message)  # type: ignore[arg-type]
        if not keep:
            self.disconnect(client)

    def disconnect(self, client: WebClient) -> None:
        with self._lock:
            self._sessions.pop(client.token, None)
        self.core._disconnect(client)  # type: ignore[arg-type]
        log.info("網頁登出：%s", client.name)

    def _reap_loop(self) -> None:
        """定期清掉「SSE 斷線且超過保留時間」的會話（例如直接關掉分頁）。"""
        while True:
            time.sleep(10)
            now = time.monotonic()
            with self._lock:
                stale = [c for c in self._sessions.values()
                         if not c.sse_active and now - c.last_seen > SESSION_LINGER]
            for client in stale:
                self.disconnect(client)


class ChatRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    app: WebChatApp  # 由 make_handler 指定

    # ------------------------------------------------------------------
    def do_GET(self) -> None:
        url = urlparse(self.path)
        if url.path in ("/", "/index.html"):
            self._serve_page()
        elif url.path == "/events":
            self._serve_events(parse_qs(url.query))
        elif url.path == "/healthz":
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        url = urlparse(self.path)
        body = self._read_json_body()
        if body is None:
            return
        if url.path == "/api/login":
            self._api_login(body)
        elif url.path == "/api/send":
            self._api_send(body)
        else:
            self._send_json(404, {"error": "not found"})

    # ------------------------------------------------------------------
    def _api_login(self, body: dict[str, Any]) -> None:
        nick = str(body.get("nick", "")).strip()
        token, reply = self.app.login(nick)
        if token is None:
            self._send_json(400, {"error": reply.get("text", "登入失敗")})
        else:
            self._send_json(200, {"token": token, "nick": reply.get("nick"),
                                  "room": reply.get("room")})

    def _api_send(self, body: dict[str, Any]) -> None:
        client = self.app.get_client(str(body.get("token", "")))
        if client is None:
            self._send_json(401, {"error": "會話已過期，請重新登入"})
            return
        message = body.get("message")
        if not isinstance(message, dict) or not isinstance(message.get("type"), str):
            self._send_json(400, {"error": "message 格式錯誤"})
            return
        self.app.dispatch(client, message)
        self._send_json(200, {"ok": True})

    def _serve_events(self, query: dict[str, list[str]]) -> None:
        token = (query.get("token") or [""])[0]
        client = self.app.get_client(token)
        if client is None:
            self._send_json(401, {"error": "會話已過期，請重新登入"})
            return

        client.sse_generation += 1
        generation = client.sse_generation
        client.sse_active = True

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")  # 關掉 nginx 類 proxy 的緩衝
        self.end_headers()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while not client.closed and client.sse_generation == generation:
                try:
                    message = client.queue.get(timeout=PING_INTERVAL)
                except Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                if message is None:  # close() 的喚醒訊號
                    break
                data = json.dumps(message, ensure_ascii=False)
                self.wfile.write(f"data: {data}\n\n".encode())
                self.wfile.flush()
                client.last_seen = time.monotonic()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # 瀏覽器關掉了分頁或斷網
        finally:
            if client.sse_generation == generation:
                client.sse_active = False
                client.last_seen = time.monotonic()

    def _serve_page(self) -> None:
        try:
            page = _WEBUI_PATH.read_bytes()
        except OSError:
            self._send_json(500, {"error": "找不到 webui.html"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(page)

    # ------------------------------------------------------------------
    def _read_json_body(self) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send_json(400, {"error": "請求主體長度不合法"})
            return None
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "請求主體不是合法的 JSON"})
            return None
        if not isinstance(body, dict):
            self._send_json(400, {"error": "請求主體必須是 JSON 物件"})
            return None
        return body

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args: Any) -> None:
        log.debug("%s %s", self.address_string(), fmt % args)


def make_server(host: str, port: int) -> tuple[ThreadingHTTPServer, WebChatApp]:
    app = WebChatApp()
    handler = type("BoundHandler", (ChatRequestHandler,), {"app": app})
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True
    return httpd, app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="啟動網頁版聊天伺服器")
    parser.add_argument("--host", default="0.0.0.0", help="監聽位址（預設 %(default)s）")
    parser.add_argument("--port", type=int, default=8000,
                        help="監聽埠號（預設 %(default)s）")
    parser.add_argument("--verbose", "-v", action="store_true", help="顯示除錯訊息")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    httpd, _ = make_server(args.host, args.port)
    log.info("網頁聊天室啟動：http://%s:%s/", *httpd.server_address[:2])
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log.info("收到中斷訊號，關閉中…")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
