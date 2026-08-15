"""網頁版的整合測試：真的開 HTTP 伺服器，用 HTTP + SSE 走完整流程。"""

import http.client
import json
import threading
import time
import unittest

from chatapp.web import make_server

TIMEOUT = 5.0


class WebSession:
    """測試用的網頁客戶端：模擬一個瀏覽器分頁。"""

    def __init__(self, address):
        self.host, self.port = address
        self.token = None
        self._sse = None
        self._sse_resp = None

    # ------------------------------------------------------------------
    def post(self, path, payload):
        conn = http.client.HTTPConnection(self.host, self.port, timeout=TIMEOUT)
        try:
            body = json.dumps(payload).encode()
            conn.request("POST", path, body=body,
                         headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            return resp.status, json.loads(resp.read())
        finally:
            conn.close()

    def login(self, nick):
        status, data = self.post("/api/login", {"nick": nick})
        if status == 200:
            self.token = data["token"]
            self.open_events()
        return status, data

    def send(self, **message):
        return self.post("/api/send", {"token": self.token, "message": message})

    # ------------------------------------------------------------------
    def open_events(self):
        self._sse = http.client.HTTPConnection(self.host, self.port, timeout=TIMEOUT)
        self._sse.request("GET", f"/events?token={self.token}")
        self._sse_resp = self._sse.getresponse()
        assert self._sse_resp.status == 200, self._sse_resp.status

    def next_event(self):
        """讀下一則 SSE 事件（略過 ping 等註解行）。"""
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            line = self._sse_resp.fp.readline()
            if not line:
                raise AssertionError("SSE 串流被關閉了")
            line = line.decode().strip()
            if line.startswith("data: "):
                return json.loads(line[len("data: "):])
        raise AssertionError("等不到 SSE 事件")

    def wait_for(self, *types):
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            event = self.next_event()
            if event["type"] in types:
                return event
        raise AssertionError(f"等不到 {types}")

    def close(self):
        if self._sse is not None:
            try:
                self._sse.close()
            except OSError:
                pass


class WebChatTest(unittest.TestCase):
    def setUp(self):
        self.httpd, self.app = make_server("127.0.0.1", 0)
        self.address = self.httpd.server_address[:2]
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()
        self.addCleanup(self.httpd.shutdown)
        self.addCleanup(self.httpd.server_close)

    def make_session(self, nick=None):
        session = WebSession(self.address)
        self.addCleanup(session.close)
        if nick is not None:
            status, data = session.login(nick)
            assert status == 200, data
            session.wait_for("welcome")
            session.wait_for("system")  # 「你加入了 lobby」＝入房流程完成
        return session

    # ------------------------------------------------------------------
    def test_serves_page(self):
        conn = http.client.HTTPConnection(*self.address, timeout=TIMEOUT)
        self.addCleanup(conn.close)
        conn.request("GET", "/")
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        self.assertIn("聊天室", resp.read().decode())

    def test_login_success(self):
        session = WebSession(self.address)
        self.addCleanup(session.close)
        status, data = session.login("amy")
        self.assertEqual(status, 200)
        self.assertEqual(data["nick"], "amy")
        self.assertEqual(data["room"], "lobby")
        self.assertTrue(data["token"])
        self.assertEqual(session.wait_for("welcome")["nick"], "amy")

    def test_login_rejects_bad_nick(self):
        session = WebSession(self.address)
        status, data = session.post("/api/login", {"nick": "有 空白"})
        self.assertEqual(status, 400)
        self.assertIn("error", data)

    def test_login_rejects_duplicate_nick(self):
        self.make_session("amy")
        session = WebSession(self.address)
        status, _ = session.post("/api/login", {"nick": "amy"})
        self.assertEqual(status, 400)

    # ------------------------------------------------------------------
    def test_chat_broadcast_between_browsers(self):
        amy = self.make_session("amy")
        bob = self.make_session("bob")
        amy.wait_for("system")  # bob 加入的通知

        amy.send(type="chat", room="lobby", text="網頁版你好")
        received = bob.wait_for("chat")
        self.assertEqual(received["sender"], "amy")
        self.assertEqual(received["text"], "網頁版你好")
        self.assertEqual(amy.wait_for("chat")["text"], "網頁版你好")

    def test_private_message(self):
        amy = self.make_session("amy")
        bob = self.make_session("bob")
        amy.send(type="private", to="bob", text="悄悄話")
        received = bob.wait_for("private")
        self.assertEqual(received["sender"], "amy")
        self.assertEqual(received["text"], "悄悄話")

    def test_join_room_and_history(self):
        amy = self.make_session("amy")
        amy.send(type="join", room="dev")
        amy.wait_for("system")
        amy.send(type="chat", room="dev", text="第一則")
        amy.wait_for("chat")

        bob = self.make_session("bob")
        bob.send(type="join", room="dev")
        history = bob.wait_for("history")
        self.assertEqual([m["text"] for m in history["messages"]], ["第一則"])

    # ------------------------------------------------------------------
    def test_send_requires_valid_token(self):
        session = WebSession(self.address)
        session.token = "fake-token"
        status, _ = session.send(type="chat", room="lobby", text="hi")
        self.assertEqual(status, 401)

    def test_send_rejects_bad_message(self):
        session = self.make_session("amy")
        status, _ = session.post("/api/send", {"token": session.token, "message": "oops"})
        self.assertEqual(status, 400)

    def test_bad_json_body(self):
        conn = http.client.HTTPConnection(*self.address, timeout=TIMEOUT)
        self.addCleanup(conn.close)
        conn.request("POST", "/api/login", body=b"{not json",
                     headers={"Content-Type": "application/json"})
        self.assertEqual(conn.getresponse().status, 400)

    def test_quit_frees_nick(self):
        amy = self.make_session("amy")
        amy.send(type="quit")
        amy.wait_for("bye")

        again = WebSession(self.address)
        self.addCleanup(again.close)
        status, _ = again.login("amy")
        self.assertEqual(status, 200)

    def test_healthz(self):
        conn = http.client.HTTPConnection(*self.address, timeout=TIMEOUT)
        self.addCleanup(conn.close)
        conn.request("GET", "/healthz")
        self.assertEqual(conn.getresponse().status, 200)


if __name__ == "__main__":
    unittest.main()
