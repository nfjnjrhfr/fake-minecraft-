"""Tests for the engine's routing and defensive behaviour."""

from __future__ import annotations

import ipaddress
import unittest

import tests.support  # noqa: F401
from tests.support import LoopbackTun, PeerConfig, ipv4_packet, make_config, udp_socket

from pyvpn import crypto
from pyvpn.device import Device, tunnel_mtu


def network(text):
    return ipaddress.IPv4Network(text)


class CryptokeyRouting(unittest.TestCase):
    def setUp(self):
        private, _ = crypto.generate_keypair()
        _, first = crypto.generate_keypair()
        _, second = crypto.generate_keypair()
        _, catch_all = crypto.generate_keypair()
        self.tun = LoopbackTun()
        self.sock = udp_socket()
        self.addCleanup(self.tun.close)
        self.addCleanup(self.sock.close)
        self.device = Device(
            make_config(
                private,
                "10.9.0.1/24",
                self.sock.getsockname()[1],
                [
                    PeerConfig(public_key=first, allowed_ips=[network("10.9.0.2/32")]),
                    PeerConfig(public_key=second, allowed_ips=[network("10.9.0.0/24")]),
                    PeerConfig(public_key=catch_all, allowed_ips=[network("0.0.0.0/0")]),
                ],
            ),
            self.tun,
            self.sock,
        )
        self.first, self.second, self.catch_all = self.device.peers

    def test_the_most_specific_prefix_wins(self):
        self.assertIs(self.device.route(ipaddress.IPv4Address("10.9.0.2")), self.first)

    def test_a_less_specific_prefix_catches_the_rest_of_the_subnet(self):
        self.assertIs(self.device.route(ipaddress.IPv4Address("10.9.0.7")), self.second)

    def test_everything_else_falls_to_the_default_peer(self):
        self.assertIs(self.device.route(ipaddress.IPv4Address("8.8.8.8")), self.catch_all)

    def test_a_packet_with_no_matching_peer_is_dropped(self):
        device = Device(
            make_config(
                crypto.generate_keypair()[0],
                "10.9.0.1/24",
                self.sock.getsockname()[1],
                [PeerConfig(public_key=crypto.generate_keypair()[1], allowed_ips=[network("10.9.0.2/32")])],
            ),
            self.tun,
            self.sock,
        )
        device.handle_outbound(ipv4_packet("10.9.0.1", "8.8.8.8"))
        self.assertEqual(device.dropped_unroutable, 1)

    def test_ipv6_is_dropped_rather_than_misrouted(self):
        self.device.handle_outbound(b"\x60" + b"\x00" * 39)
        self.assertEqual(self.device.dropped_unroutable, 1)

    def test_data_for_an_unknown_session_is_dropped(self):
        from pyvpn.messages import data_header

        self.device.handle_inbound(data_header(0xDEADBEEF, 0) + b"\x00" * 16, ("127.0.0.1", 1))
        self.assertEqual(self.device.dropped_unknown, 1)

    def test_packets_are_queued_while_a_session_is_negotiated(self):
        self.catch_all.endpoint = ("127.0.0.1", 9)
        self.device.handle_outbound(ipv4_packet("10.9.0.1", "8.8.8.8"))
        self.assertEqual(len(self.catch_all.queue), 1)

    def test_the_queue_is_bounded(self):
        from pyvpn.peer import MAX_QUEUED_PACKETS

        self.catch_all.endpoint = ("127.0.0.1", 9)
        for _ in range(MAX_QUEUED_PACKETS + 50):
            self.device.handle_outbound(ipv4_packet("10.9.0.1", "8.8.8.8"))
        self.assertEqual(len(self.catch_all.queue), MAX_QUEUED_PACKETS)


class HandshakeRateLimit(unittest.TestCase):
    def setUp(self):
        self.tun = LoopbackTun()
        self.sock = udp_socket()
        self.addCleanup(self.tun.close)
        self.addCleanup(self.sock.close)
        self.device = Device(
            make_config(
                crypto.generate_keypair()[0],
                "10.9.0.1/24",
                self.sock.getsockname()[1],
                [PeerConfig(public_key=crypto.generate_keypair()[1], allowed_ips=[network("10.9.0.2/32")])],
            ),
            self.tun,
            self.sock,
        )

    def test_a_flood_from_one_address_is_throttled(self):
        from pyvpn.device import HANDSHAKES_PER_SECOND

        sender = ("198.51.100.7", 1234)
        allowed = sum(self.device._allow_handshake(sender) for _ in range(200))
        self.assertEqual(allowed, HANDSHAKES_PER_SECOND)

    def test_other_addresses_are_unaffected(self):
        for _ in range(200):
            self.device._allow_handshake(("198.51.100.7", 1234))
        self.assertTrue(self.device._allow_handshake(("203.0.113.9", 1234)))


class Mtu(unittest.TestCase):
    def test_the_tunnel_mtu_leaves_room_for_every_header(self):
        self.assertEqual(tunnel_mtu(1500), 1440)

    def test_a_smaller_path_yields_a_smaller_tunnel(self):
        self.assertEqual(tunnel_mtu(1400), 1340)


if __name__ == "__main__":
    unittest.main()
