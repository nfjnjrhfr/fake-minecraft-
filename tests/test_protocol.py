"""protocol 模組的單元測試。"""

import socket
import unittest

from chatapp import protocol
from chatapp.protocol import LineReader, ProtocolError


class EncodeDecodeTest(unittest.TestCase):
    def test_round_trip(self):
        message = {"type": "chat", "text": "哈囉", "room": "lobby"}
        self.assertEqual(protocol.decode(protocol.encode(message)), message)

    def test_encode_ends_with_newline(self):
        self.assertTrue(protocol.encode({"type": "ping"}).endswith(b"\n"))

    def test_encode_keeps_unicode_readable(self):
        # ensure_ascii=False，中文不該被轉成 \uXXXX
        self.assertIn("哈囉".encode(), protocol.encode({"type": "chat", "text": "哈囉"}))

    def test_encode_requires_type(self):
        with self.assertRaises(ProtocolError):
            protocol.encode({"text": "沒有 type"})

    def test_decode_rejects_bad_json(self):
        with self.assertRaises(ProtocolError):
            protocol.decode(b"{not json")

    def test_decode_rejects_non_object(self):
        with self.assertRaises(ProtocolError):
            protocol.decode(b'["a", "list"]')

    def test_decode_rejects_missing_type(self):
        with self.assertRaises(ProtocolError):
            protocol.decode(b'{"text": "hi"}')

    def test_decode_rejects_invalid_utf8(self):
        with self.assertRaises(ProtocolError):
            protocol.decode(b'{"type": "chat", "text": "\xff\xfe"}')


class LineReaderTest(unittest.TestCase):
    def setUp(self):
        self.a, self.b = socket.socketpair()
        self.addCleanup(self.a.close)
        self.addCleanup(self.b.close)

    def test_splits_multiple_messages_in_one_chunk(self):
        # 黏包：兩則訊息在同一次 send 裡
        self.a.sendall(b'{"type":"a"}\n{"type":"b"}\n')
        self.a.shutdown(socket.SHUT_WR)
        types = [m["type"] for m in LineReader(self.b)]
        self.assertEqual(types, ["a", "b"])

    def test_reassembles_split_message(self):
        # 拆包：一則訊息被切成兩次 send
        self.a.sendall(b'{"type":"hel')
        self.a.sendall(b'lo"}\n')
        self.a.shutdown(socket.SHUT_WR)
        self.assertEqual([m["type"] for m in LineReader(self.b)], ["hello"])

    def test_skips_blank_lines(self):
        self.a.sendall(b'\n\n{"type":"a"}\n\n')
        self.a.shutdown(socket.SHUT_WR)
        self.assertEqual([m["type"] for m in LineReader(self.b)], ["a"])

    def test_stops_on_close(self):
        self.a.close()
        self.assertEqual(list(LineReader(self.b)), [])

    def test_rejects_oversized_line(self):
        reader = LineReader(self.b, max_line=16)
        self.a.sendall(b"x" * 64)
        with self.assertRaises(ProtocolError):
            list(reader)


if __name__ == "__main__":
    unittest.main()
