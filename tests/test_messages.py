"""Tests for the wire format."""

from __future__ import annotations

import unittest

import tests.support  # noqa: F401

from pyvpn import messages
from pyvpn.messages import Initiation, MalformedPacket, Response


class Framing(unittest.TestCase):
    def test_initiation_round_trip(self):
        original = Initiation(
            sender=0xDEADBEEF,
            ephemeral=b"e" * 32,
            enc_static=b"s" * 48,
            enc_timestamp=b"t" * 28,
            mac1=b"1" * 16,
            mac2=b"2" * 16,
        )
        raw = original.to_bytes()
        self.assertEqual(len(raw), messages.INITIATION_LEN)
        self.assertEqual(Initiation.from_bytes(raw), original)

    def test_response_round_trip(self):
        original = Response(
            sender=1, receiver=2, ephemeral=b"e" * 32, enc_empty=b"x" * 16
        )
        raw = original.to_bytes()
        self.assertEqual(len(raw), messages.RESPONSE_LEN)
        self.assertEqual(Response.from_bytes(raw), original)

    def test_data_header_round_trip(self):
        header = messages.data_header(0x11223344, 0xFFFF_FFFF_FF)
        self.assertEqual(len(header), messages.DATA_HEADER_LEN)
        receiver, counter = messages.parse_data_header(header + b"\x00" * 16)
        self.assertEqual((receiver, counter), (0x11223344, 0xFFFF_FFFF_FF))

    def test_every_message_starts_with_its_type(self):
        self.assertEqual(
            messages.message_type(
                Initiation(
                    sender=0, ephemeral=b"e" * 32, enc_static=b"s" * 48,
                    enc_timestamp=b"t" * 28,
                ).to_bytes()
            ),
            messages.MSG_INITIATION,
        )
        self.assertEqual(
            messages.message_type(messages.data_header(1, 1)), messages.MSG_DATA
        )

    def test_mac1_covers_everything_before_the_macs(self):
        initiation = Initiation(
            sender=1, ephemeral=b"e" * 32, enc_static=b"s" * 48, enc_timestamp=b"t" * 28
        )
        self.assertEqual(len(initiation.mac1_input), messages.INITIATION_LEN - 32)
        self.assertEqual(initiation.mac1_input, initiation.to_bytes()[:-32])


class Malformed(unittest.TestCase):
    def test_truncated_packet_is_rejected(self):
        with self.assertRaises(MalformedPacket):
            messages.message_type(b"\x01\x00")

    def test_short_initiation_is_rejected(self):
        with self.assertRaises(MalformedPacket):
            Initiation.from_bytes(b"\x01" + b"\x00" * 100)

    def test_wrong_type_is_rejected(self):
        raw = bytearray(
            Response(sender=1, receiver=2, ephemeral=b"e" * 32, enc_empty=b"x" * 16).to_bytes()
        )
        raw[0] = messages.MSG_INITIATION
        with self.assertRaises(MalformedPacket):
            Response.from_bytes(bytes(raw))

    def test_data_packet_without_room_for_a_tag_is_rejected(self):
        with self.assertRaises(MalformedPacket):
            messages.parse_data_header(messages.data_header(1, 1))

    def test_random_bytes_do_not_parse_as_an_initiation(self):
        import os

        with self.assertRaises(MalformedPacket):
            Initiation.from_bytes(os.urandom(64))


if __name__ == "__main__":
    unittest.main()
