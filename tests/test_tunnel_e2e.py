"""End-to-end tests: two devices, real UDP sockets, real cryptography.

The only thing faked is the kernel interface itself, so these cover the
handshake, both encryption directions, cryptokey routing, rekeying and
replay rejection exactly as they run in production.
"""

from __future__ import annotations

import ipaddress
import time
import unittest

from tests.support import (
    LoopbackTun,
    PeerConfig,
    RunningDevice,
    SpySocket,
    ipv4_packet,
    make_config,
    peer_pair,
    udp_socket,
)

from pyvpn.device import Device
from pyvpn.peer import Keypair

SERVER_TUN_IP = "10.9.0.1"
CLIENT_TUN_IP = "10.9.0.2"


class TunnelTestCase(unittest.TestCase):
    def setUp(self) -> None:
        (self.s_priv, self.s_pub), (self.c_priv, self.c_pub), self.psk = peer_pair()

        self.server_sock = udp_socket()
        self.client_sock = SpySocket(udp_socket())
        self.server_port = self.server_sock.getsockname()[1]

        self.server_tun = LoopbackTun("srv0")
        self.client_tun = LoopbackTun("cli0")
        self.addCleanup(self.server_tun.close)
        self.addCleanup(self.client_tun.close)
        self.addCleanup(self.server_sock.close)
        self.addCleanup(self.client_sock.close)

        server_config = make_config(
            self.s_priv,
            f"{SERVER_TUN_IP}/24",
            self.server_port,
            [
                PeerConfig(
                    public_key=self.c_pub,
                    allowed_ips=[ipaddress.IPv4Network(f"{CLIENT_TUN_IP}/32")],
                    preshared_key=self.psk,
                )
            ],
        )
        client_config = make_config(
            self.c_priv,
            f"{CLIENT_TUN_IP}/24",
            self.client_sock.getsockname()[1],
            [
                PeerConfig(
                    public_key=self.s_pub,
                    allowed_ips=[ipaddress.IPv4Network("0.0.0.0/0")],
                    endpoint=("127.0.0.1", self.server_port),
                    preshared_key=self.psk,
                )
            ],
        )
        self.server = Device(server_config, self.server_tun, self.server_sock)
        self.client = Device(client_config, self.client_tun, self.client_sock)


class HandshakeAndTransport(TunnelTestCase):
    def test_client_traffic_reaches_the_server_side(self):
        """A packet sent into the client's tunnel comes out of the server's."""
        with RunningDevice(self.server), RunningDevice(self.client):
            packet = ipv4_packet(CLIENT_TUN_IP, "8.8.8.8", b"hello internet")
            self.client_tun.inject(packet)
            delivered = self.server_tun.wait_for(1)

        self.assertEqual(delivered[:1], [packet], "packet did not survive the tunnel")
        peer = self.client.peers[0]
        self.assertIsNotNone(peer.current, "client never completed a handshake")
        self.assertEqual(peer.stats.tx_packets, 1)

    def test_return_traffic_reaches_the_client(self):
        """Replies from the far side come back through the tunnel."""
        with RunningDevice(self.server), RunningDevice(self.client):
            self.client_tun.inject(ipv4_packet(CLIENT_TUN_IP, "8.8.8.8"))
            self.server_tun.wait_for(1)

            reply = ipv4_packet("8.8.8.8", CLIENT_TUN_IP, b"hello back")
            self.server_tun.inject(reply)
            delivered = self.client_tun.wait_for(1)

        self.assertIn(reply, delivered)

    def test_traffic_on_the_wire_is_encrypted(self):
        """The plaintext must never appear in a datagram we transmit."""
        secret = b"SUPER-SECRET-PAYLOAD-abcdef"

        with RunningDevice(self.server), RunningDevice(self.client):
            self.client_tun.inject(ipv4_packet(CLIENT_TUN_IP, "8.8.8.8", secret))
            self.server_tun.wait_for(1)

        captured = self.client_sock.sent
        self.assertTrue(captured, "client sent nothing")
        for datagram in captured:
            self.assertNotIn(secret, datagram)
            self.assertNotIn(bytes.fromhex("0a090002"), datagram[16:])  # inner source IP

    def test_many_packets_arrive_in_order_and_intact(self):
        payloads = [f"packet-{index:04d}".encode() for index in range(200)]
        with RunningDevice(self.server), RunningDevice(self.client):
            # Warm the tunnel first: packets offered before a session exists
            # are queued in a deliberately bounded buffer and may be dropped.
            self.client_tun.inject(ipv4_packet(CLIENT_TUN_IP, "8.8.8.8", b"warmup"))
            self.server_tun.wait_for(1)

            for payload in payloads:
                self.client_tun.inject(ipv4_packet(CLIENT_TUN_IP, "8.8.8.8", payload))
            delivered = self.server_tun.wait_for(len(payloads) + 1, timeout=20)

        self.assertEqual(len(delivered), len(payloads) + 1)
        self.assertEqual([packet[28:] for packet in delivered[1:]], payloads)


class Enforcement(TunnelTestCase):
    def test_replayed_datagram_is_dropped(self):
        """Capturing and re-sending a datagram must not duplicate the packet."""
        with RunningDevice(self.server), RunningDevice(self.client):
            self.client_tun.inject(ipv4_packet(CLIENT_TUN_IP, "8.8.8.8", b"once"))
            self.server_tun.wait_for(1)
            data = self.client_sock.data_packets()
            self.assertTrue(data, "no data packet was captured")

            before = len(self.server_tun.written)
            self.client_sock.sendto(data[-1], ("127.0.0.1", self.server_port))
            time.sleep(0.4)
            self.assertEqual(len(self.server_tun.written), before, "replay was accepted")
        self.assertEqual(self.server.peers[0].stats.dropped_replay, 1)

    def test_tampered_ciphertext_is_rejected(self):
        with RunningDevice(self.server), RunningDevice(self.client):
            self.client_tun.inject(ipv4_packet(CLIENT_TUN_IP, "8.8.8.8", b"once"))
            self.server_tun.wait_for(1)
            original = self.client_sock.data_packets()[-1]

            # Flip a bit inside the ciphertext but keep the counter fresh.
            forged = bytearray(original)
            forged[8:16] = (9999).to_bytes(8, "little")
            forged[-1] ^= 0x01
            before = len(self.server_tun.written)
            self.client_sock.sendto(bytes(forged), ("127.0.0.1", self.server_port))
            time.sleep(0.4)
            self.assertEqual(len(self.server_tun.written), before)
        self.assertGreaterEqual(self.server.peers[0].stats.dropped_auth, 1)

    def test_source_address_outside_allowed_ips_is_dropped(self):
        """A client must not be able to spoof another tunnel address."""
        with RunningDevice(self.server), RunningDevice(self.client):
            self.client_tun.inject(ipv4_packet(CLIENT_TUN_IP, "8.8.8.8"))
            self.server_tun.wait_for(1)
            before = len(self.server_tun.written)

            spoofed = ipv4_packet("10.9.0.99", "8.8.8.8", b"not mine")
            keypair = self.client.peers[0].sending_keypair()
            self.client.handle_outbound(spoofed)
            self.assertIsNotNone(keypair)
            time.sleep(0.4)
            self.assertEqual(len(self.server_tun.written), before)
        self.assertEqual(self.server.peers[0].stats.dropped_routing, 1)

    def test_unknown_peer_key_is_refused(self):
        """An initiation from a key we do not configure gets no response."""
        from pyvpn import crypto
        from pyvpn.config import PeerConfig as PC
        from pyvpn.noise import HandshakeState

        stranger_priv, stranger_pub = crypto.generate_keypair()
        with RunningDevice(self.server):
            state = HandshakeState(stranger_priv, stranger_pub, self.s_pub)
            initiation = state.create_initiation(0xABCD1234)
            self.client_sock.sendto(initiation.to_bytes(), ("127.0.0.1", self.server_port))
            time.sleep(0.4)
            self.assertEqual(self.server._by_index, {}, "server created a session")
        del PC, stranger_pub


class Rekeying(TunnelTestCase):
    def test_expired_keys_force_a_new_handshake(self):
        with RunningDevice(self.server), RunningDevice(self.client):
            self.client_tun.inject(ipv4_packet(CLIENT_TUN_IP, "8.8.8.8"))
            self.server_tun.wait_for(1)
            peer = self.client.peers[0]
            first: Keypair = peer.current
            self.assertIsNotNone(first)

            # Age the session past the rekey threshold, but not past the
            # point where it would simply be discarded.
            first.created_at -= 130
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and peer.current is first:
                time.sleep(0.1)

            self.assertIsNot(peer.current, first, "no rekey happened")
            self.assertIsNotNone(peer.current)

            # The refreshed session must still carry traffic.
            packet = ipv4_packet(CLIENT_TUN_IP, "8.8.8.8", b"after rekey")
            self.client_tun.inject(packet)
            delivered = self.server_tun.wait_for(2, timeout=10)
        self.assertIn(packet, delivered)


if __name__ == "__main__":
    unittest.main(verbosity=2)
