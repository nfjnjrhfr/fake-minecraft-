"""好友系統的測試：邀請、接受、拒絕、刪除、離線邀請與存檔。"""

import tempfile
import unittest
from pathlib import Path

from chatapp import protocol
from chatapp.server import ChatServer, FriendStore
from test_server import TestClient


class FriendStoreTest(unittest.TestCase):
    def test_request_and_accept(self):
        store = FriendStore()
        self.assertEqual(store.request("amy", "bob"), "sent")
        self.assertEqual(store.incoming_of("bob"), ["amy"])
        self.assertEqual(store.outgoing_of("amy"), ["bob"])
        self.assertTrue(store.accept("bob", "amy"))
        self.assertTrue(store.are_friends("amy", "bob"))
        self.assertTrue(store.are_friends("bob", "amy"))
        self.assertEqual(store.incoming_of("bob"), [])

    def test_mutual_request_becomes_friends(self):
        store = FriendStore()
        store.request("amy", "bob")
        self.assertEqual(store.request("bob", "amy"), "friends")
        self.assertTrue(store.are_friends("amy", "bob"))

    def test_duplicate_and_already_friends(self):
        store = FriendStore()
        store.request("amy", "bob")
        self.assertEqual(store.request("amy", "bob"), "duplicate")
        store.accept("bob", "amy")
        self.assertEqual(store.request("amy", "bob"), "already_friends")

    def test_decline(self):
        store = FriendStore()
        store.request("amy", "bob")
        self.assertTrue(store.decline("bob", "amy"))
        self.assertFalse(store.are_friends("amy", "bob"))
        self.assertFalse(store.decline("bob", "amy"))  # 已經處理過了

    def test_remove(self):
        store = FriendStore()
        store.request("amy", "bob")
        store.accept("bob", "amy")
        self.assertTrue(store.remove("amy", "bob"))
        self.assertFalse(store.are_friends("bob", "amy"))
        self.assertFalse(store.remove("amy", "bob"))

    def test_case_insensitive(self):
        store = FriendStore()
        store.request("Amy", "BOB")
        self.assertTrue(store.accept("bob", "amy"))
        self.assertTrue(store.are_friends("AMY", "Bob"))

    def test_persistence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "friends.json"
            store = FriendStore(path)
            store.remember("Amy")
            store.request("Amy", "bob")
            store.accept("bob", "Amy")
            store.request("carol", "Amy")

            reloaded = FriendStore(path)
            self.assertTrue(reloaded.are_friends("amy", "bob"))
            self.assertEqual(reloaded.incoming_of("Amy"), ["carol"])
            self.assertEqual(reloaded.display("amy"), "Amy")


class FriendFlowTest(unittest.TestCase):
    """走真的 socket 連線驗證好友互動。"""

    def setUp(self):
        self.server = ChatServer(host="127.0.0.1", port=0)
        self.address = self.server.start()
        self.addCleanup(self.server.stop)

    def make_client(self, nick=None):
        client = TestClient(self.address)
        self.addCleanup(client.close)
        if nick is not None:
            client.login(nick)
        return client

    def test_login_sends_friend_list(self):
        amy = TestClient(self.address)
        self.addCleanup(amy.close)
        amy.send(type=protocol.LOGIN, nick="amy")
        amy.wait_for(protocol.WELCOME)
        listing = amy.wait_for(protocol.FRIEND_LIST)
        self.assertEqual(listing["friends"], [])
        self.assertEqual(listing["incoming"], [])

    def test_request_notifies_online_target(self):
        amy = self.make_client("amy")
        bob = self.make_client("bob")
        amy.send(type=protocol.FRIEND_ADD, to="bob")

        event = bob.wait_for(protocol.FRIEND_EVENT)
        self.assertEqual(event["event"], "request")
        self.assertEqual(event["nick"], "amy")
        listing = bob.wait_for(protocol.FRIEND_LIST)
        self.assertEqual(listing["incoming"], ["amy"])

    def test_accept_makes_friends_both_sides(self):
        amy = self.make_client("amy")
        bob = self.make_client("bob")
        amy.send(type=protocol.FRIEND_ADD, to="bob")
        bob.wait_for(protocol.FRIEND_EVENT)
        bob.send(type=protocol.FRIEND_ACCEPT, nick="amy")

        event = amy.wait_for(protocol.FRIEND_EVENT)
        self.assertEqual(event["event"], "accepted")
        listing = amy.wait_for(protocol.FRIEND_LIST)
        self.assertEqual([f["nick"] for f in listing["friends"]], ["bob"])
        self.assertTrue(listing["friends"][0]["online"])

        bob.send(type=protocol.LIST_FRIENDS)
        listing = bob.wait_for(protocol.FRIEND_LIST)
        while not listing["friends"]:  # 略過收到邀請當下的舊快照
            listing = bob.wait_for(protocol.FRIEND_LIST)
        self.assertEqual([f["nick"] for f in listing["friends"]], ["amy"])

    def test_offline_request_delivered_on_login(self):
        amy = self.make_client("amy")
        amy.send(type=protocol.FRIEND_ADD, to="carol")  # carol 還沒上線過
        amy.wait_for(protocol.SYSTEM)

        carol = self.make_client()
        carol.send(type=protocol.LOGIN, nick="carol")
        carol.wait_for(protocol.WELCOME)
        listing = carol.wait_for(protocol.FRIEND_LIST)
        self.assertEqual(listing["incoming"], ["amy"])

    def test_decline_notifies_requester(self):
        amy = self.make_client("amy")
        bob = self.make_client("bob")
        amy.send(type=protocol.FRIEND_ADD, to="bob")
        bob.wait_for(protocol.FRIEND_EVENT)
        bob.send(type=protocol.FRIEND_DECLINE, nick="amy")
        self.assertEqual(amy.wait_for(protocol.FRIEND_EVENT)["event"], "declined")

    def test_remove_friend(self):
        amy = self.make_client("amy")
        bob = self.make_client("bob")
        amy.send(type=protocol.FRIEND_ADD, to="bob")
        bob.wait_for(protocol.FRIEND_EVENT)
        bob.send(type=protocol.FRIEND_ACCEPT, nick="amy")
        amy.wait_for(protocol.FRIEND_EVENT)

        amy.send(type=protocol.FRIEND_REMOVE, nick="bob")
        self.assertEqual(bob.wait_for(protocol.FRIEND_EVENT,
                                      ignore_system=True)["event"], "removed")

    def test_cannot_add_self(self):
        amy = self.make_client("amy")
        amy.send(type=protocol.FRIEND_ADD, to="amy")
        self.assertIn("自己", amy.wait_for(protocol.ERROR)["text"])

    def test_friend_online_offline_events(self):
        amy = self.make_client("amy")
        bob = self.make_client("bob")
        amy.send(type=protocol.FRIEND_ADD, to="bob")
        bob.wait_for(protocol.FRIEND_EVENT)
        bob.send(type=protocol.FRIEND_ACCEPT, nick="amy")
        amy.wait_for(protocol.FRIEND_EVENT)

        bob.close()  # 直接斷線
        deadline_events = []
        while True:
            event = amy.wait_for(protocol.FRIEND_EVENT)
            deadline_events.append(event["event"])
            if event["event"] == "offline":
                break
        self.assertEqual(deadline_events[-1], "offline")


if __name__ == "__main__":
    unittest.main()
