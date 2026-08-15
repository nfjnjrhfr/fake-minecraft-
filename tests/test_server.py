"""伺服器的整合測試：真的開一個 server、真的用 socket 連進去。"""

import socket
import time
import unittest

from chatapp import protocol
from chatapp.protocol import LineReader
from chatapp.server import ChatServer

TIMEOUT = 5.0


class TestClient:
    """測試用的極簡客戶端：可以送訊息、也可以等特定型別的訊息。"""

    def __init__(self, address):
        self.sock = socket.create_connection(address, timeout=TIMEOUT)
        self.sock.settimeout(TIMEOUT)
        self._messages = LineReader(self.sock)
        self._iter = iter(self._messages)

    def send(self, **message):
        protocol.send(self.sock, message)

    def login(self, nick):
        """登入並等到「加入預設房間」整套流程跑完，避免後續斷言遇到競態。"""
        self.send(type=protocol.LOGIN, nick=nick)
        reply = self.wait_for(protocol.WELCOME, protocol.ERROR)
        if reply["type"] == protocol.WELCOME:
            self.wait_for(protocol.SYSTEM)  # 自己的「你加入了…」，是入房流程的最後一步
        return reply

    def next_message(self):
        return next(self._iter)

    def wait_for(self, *types, ignore_system=True):
        """讀到指定型別的訊息就回傳；期間的其他訊息會被略過。"""
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            message = self.next_message()
            if message["type"] in types:
                return message
            if not ignore_system and message["type"] not in (
                protocol.SYSTEM, protocol.USER_LIST, protocol.HISTORY
            ):
                raise AssertionError(f"非預期的訊息：{message}")
        raise AssertionError(f"等不到 {types}")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class ChatServerTest(unittest.TestCase):
    def setUp(self):
        self.server = ChatServer(host="127.0.0.1", port=0)
        self.address = self.server.start()
        self.addCleanup(self.server.stop)
        self._clients = []

    def make_client(self, nick=None):
        client = TestClient(self.address)
        self._clients.append(client)
        self.addCleanup(client.close)
        if nick is not None:
            client.login(nick)
        return client

    # ------------------------------------------------------------------
    def test_login_returns_welcome(self):
        client = self.make_client()
        welcome = client.login("amy")
        self.assertEqual(welcome["type"], protocol.WELCOME)
        self.assertEqual(welcome["nick"], "amy")
        self.assertEqual(welcome["room"], "lobby")

    def test_duplicate_nick_rejected(self):
        self.make_client("amy")
        second = self.make_client()
        reply = second.login("AMY")  # 不分大小寫
        self.assertEqual(reply["type"], protocol.ERROR)

    def test_invalid_nick_rejected(self):
        client = self.make_client()
        self.assertEqual(client.login("")["type"], protocol.ERROR)
        self.assertEqual(client.login("a b c")["type"], protocol.ERROR)
        self.assertEqual(client.login("x" * 21)["type"], protocol.ERROR)

    def test_chinese_nick_accepted(self):
        client = self.make_client()
        self.assertEqual(client.login("小明")["type"], protocol.WELCOME)

    def test_commands_require_login(self):
        client = self.make_client()
        client.send(type=protocol.CHAT, text="偷跑")
        self.assertEqual(client.wait_for(protocol.ERROR)["type"], protocol.ERROR)

    # ------------------------------------------------------------------
    def test_broadcast_to_same_room(self):
        amy = self.make_client("amy")
        bob = self.make_client("bob")
        amy.send(type=protocol.CHAT, room="lobby", text="大家好")

        received = bob.wait_for(protocol.CHAT)
        self.assertEqual(received["sender"], "amy")
        self.assertEqual(received["text"], "大家好")
        self.assertEqual(received["room"], "lobby")
        # 送出者自己也會收到（所以每個人看到的順序一致）
        self.assertEqual(amy.wait_for(protocol.CHAT)["text"], "大家好")

    def test_message_not_leaked_across_rooms(self):
        amy = self.make_client("amy")
        bob = self.make_client("bob")
        amy.send(type=protocol.JOIN, room="secret")
        amy.wait_for(protocol.SYSTEM)
        amy.send(type=protocol.CHAT, room="secret", text="機密")

        # bob 只在 lobby，不該收到 secret 的訊息；改用 lobby 的訊息當同步點
        amy.send(type=protocol.CHAT, room="lobby", text="公開")
        received = bob.wait_for(protocol.CHAT)
        self.assertEqual(received["text"], "公開")

    def test_chat_to_room_not_joined_is_error(self):
        amy = self.make_client("amy")
        amy.send(type=protocol.CHAT, room="nowhere", text="hi")
        self.assertIn("nowhere", amy.wait_for(protocol.ERROR)["text"])

    def test_empty_and_oversized_text_rejected(self):
        amy = self.make_client("amy")
        amy.send(type=protocol.CHAT, room="lobby", text="   ")
        self.assertEqual(amy.wait_for(protocol.ERROR)["type"], protocol.ERROR)
        amy.send(type=protocol.CHAT, room="lobby", text="x" * 3000)
        self.assertEqual(amy.wait_for(protocol.ERROR)["type"], protocol.ERROR)

    # ------------------------------------------------------------------
    def test_private_message(self):
        amy = self.make_client("amy")
        bob = self.make_client("bob")
        amy.send(type=protocol.PRIVATE, to="bob", text="悄悄話")

        received = bob.wait_for(protocol.PRIVATE)
        self.assertEqual(received["sender"], "amy")
        self.assertEqual(received["to"], "bob")
        self.assertEqual(received["text"], "悄悄話")
        # 寄件者會收到回聲
        self.assertEqual(amy.wait_for(protocol.PRIVATE)["text"], "悄悄話")

    def test_private_message_to_unknown_user(self):
        amy = self.make_client("amy")
        amy.send(type=protocol.PRIVATE, to="nobody", text="hi")
        self.assertIn("nobody", amy.wait_for(protocol.ERROR)["text"])

    # ------------------------------------------------------------------
    def test_join_sends_history_to_newcomer(self):
        amy = self.make_client("amy")
        amy.send(type=protocol.JOIN, room="dev")
        amy.wait_for(protocol.SYSTEM)
        amy.send(type=protocol.CHAT, room="dev", text="第一則")
        amy.wait_for(protocol.CHAT)

        bob = self.make_client("bob")
        bob.send(type=protocol.JOIN, room="dev")
        history = bob.wait_for(protocol.HISTORY)
        self.assertEqual([m["text"] for m in history["messages"]], ["第一則"])

    def test_join_notifies_existing_members(self):
        amy = self.make_client("amy")
        bob = self.make_client("bob")
        notice = amy.wait_for(protocol.SYSTEM)
        self.assertIn("bob", notice["text"])
        self.assertIsNotNone(bob)

    def test_leave_removes_from_room(self):
        amy = self.make_client("amy")
        bob = self.make_client("bob")
        bob.send(type=protocol.LEAVE, room="lobby")
        bob.wait_for(protocol.SYSTEM)

        amy.send(type=protocol.LIST_USERS, room="lobby")
        users = amy.wait_for(protocol.USER_LIST)["users"]
        self.assertEqual(users, ["amy"])

    def test_invalid_room_name_rejected(self):
        amy = self.make_client("amy")
        amy.send(type=protocol.JOIN, room="有 空白")
        self.assertEqual(amy.wait_for(protocol.ERROR)["type"], protocol.ERROR)

    # ------------------------------------------------------------------
    def test_list_rooms(self):
        amy = self.make_client("amy")
        amy.send(type=protocol.JOIN, room="dev")
        amy.wait_for(protocol.SYSTEM)
        amy.send(type=protocol.LIST_ROOMS)

        rooms = {r["name"]: r["users"] for r in amy.wait_for(protocol.ROOM_LIST)["rooms"]}
        self.assertEqual(rooms, {"lobby": 1, "dev": 1})

    def test_list_users(self):
        amy = self.make_client("amy")
        self.make_client("bob")
        amy.send(type=protocol.LIST_USERS, room="lobby")
        self.assertEqual(amy.wait_for(protocol.USER_LIST)["users"], ["amy", "bob"])

    def test_unknown_message_type(self):
        amy = self.make_client("amy")
        amy.send(type="teleport", x=1)
        self.assertIn("teleport", amy.wait_for(protocol.ERROR)["text"])

    def test_malformed_json_gets_error_not_crash(self):
        amy = self.make_client("amy")
        amy.sock.sendall(b"{ this is not json }\n")
        self.assertEqual(amy.wait_for(protocol.ERROR)["type"], protocol.ERROR)

    # ------------------------------------------------------------------
    def test_quit_closes_connection(self):
        amy = self.make_client("amy")
        amy.send(type=protocol.QUIT)
        self.assertEqual(amy.wait_for(protocol.BYE)["type"], protocol.BYE)
        self.assertEqual(list(amy._iter), [])  # 伺服器已關閉連線

    def test_disconnect_notifies_room_and_frees_nick(self):
        amy = self.make_client("amy")
        bob = self.make_client("bob")
        amy.wait_for(protocol.SYSTEM)  # bob 加入的通知
        bob.close()

        notice = amy.wait_for(protocol.SYSTEM)
        self.assertIn("bob", notice["text"])

        # 暱稱釋出後別人可以再用
        carol = self.make_client()
        self.assertEqual(carol.login("bob")["type"], protocol.WELCOME)

    def test_many_clients(self):
        clients = [self.make_client(f"user{i}") for i in range(10)]
        clients[0].send(type=protocol.LIST_USERS, room="lobby")
        users = clients[0].wait_for(protocol.USER_LIST)["users"]
        self.assertEqual(len(users), 10)


if __name__ == "__main__":
    unittest.main()
