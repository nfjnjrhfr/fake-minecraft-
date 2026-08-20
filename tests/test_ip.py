"""Tests for IPv4 header inspection."""

from __future__ import annotations

import ipaddress
import unittest

import tests.support  # noqa: F401
from tests.support import ipv4_packet

from pyvpn import ip


class ParseIPv4(unittest.TestCase):
    def test_addresses_and_length_are_read(self):
        packet = ipv4_packet("10.0.0.1", "8.8.8.8", b"payload")
        header = ip.parse_ipv4(packet)
        self.assertIsNotNone(header)
        self.assertEqual(header.source, ipaddress.IPv4Address("10.0.0.1"))
        self.assertEqual(header.destination, ipaddress.IPv4Address("8.8.8.8"))
        self.assertEqual(header.total_length, len(packet))
        self.assertEqual(header.protocol, 17)

    def test_ipv6_is_not_parsed(self):
        self.assertIsNone(ip.parse_ipv4(b"\x60" + b"\x00" * 39))
        self.assertEqual(ip.version(b"\x60" + b"\x00" * 39), 6)

    def test_truncated_packet_is_not_parsed(self):
        self.assertIsNone(ip.parse_ipv4(b"\x45\x00\x00\x1c"))

    def test_empty_input_is_handled(self):
        self.assertIsNone(ip.parse_ipv4(b""))
        self.assertEqual(ip.version(b""), 0)

    def test_a_length_longer_than_the_buffer_is_rejected(self):
        packet = bytearray(ipv4_packet("10.0.0.1", "8.8.8.8"))
        packet[2:4] = (9000).to_bytes(2, "big")
        self.assertIsNone(ip.parse_ipv4(bytes(packet)))


class Trim(unittest.TestCase):
    def test_padding_is_removed(self):
        packet = ipv4_packet("10.0.0.1", "8.8.8.8", b"payload")
        self.assertEqual(ip.trim(packet + b"\x00" * 9), packet)

    def test_an_unpadded_packet_is_unchanged(self):
        packet = ipv4_packet("10.0.0.1", "8.8.8.8", b"payload")
        self.assertEqual(ip.trim(packet), packet)

    def test_unparseable_input_is_passed_through(self):
        self.assertEqual(ip.trim(b"\x60garbage"), b"\x60garbage")


if __name__ == "__main__":
    unittest.main()
