"""Tests for configuration parsing."""

from __future__ import annotations

import ipaddress
import unittest

import tests.support  # noqa: F401

from pyvpn import config, crypto
from pyvpn.config import ConfigError, encode_key


def keys():
    private, public = crypto.generate_keypair()
    return encode_key(private), encode_key(public)


class ServerConfig(unittest.TestCase):
    def setUp(self):
        self.private, _ = keys()
        _, self.peer_public = keys()
        self.text = f"""
        [Interface]
        PrivateKey = {self.private}
        Address = 10.9.0.1/24
        ListenPort = 51820
        MTU = 1380
        NAT = on
        WanInterface = eth1

        [Peer]   # a laptop
        PublicKey = {self.peer_public}
        AllowedIPs = 10.9.0.2/32, 10.9.0.3/32
        PersistentKeepalive = 25
        """

    def test_interface_is_parsed(self):
        parsed = config.parse(self.text)
        interface = parsed.interface
        self.assertEqual(interface.address, ipaddress.IPv4Interface("10.9.0.1/24"))
        self.assertEqual(interface.listen_port, 51820)
        self.assertEqual(interface.mtu, 1380)
        self.assertTrue(interface.nat)
        self.assertEqual(interface.wan_interface, "eth1")

    def test_peer_is_parsed(self):
        peer = config.parse(self.text).peers[0]
        self.assertEqual(len(peer.allowed_ips), 2)
        self.assertEqual(peer.persistent_keepalive, 25)
        self.assertIsNone(peer.endpoint)
        self.assertIsNone(peer.preshared_key)

    def test_comments_and_blank_lines_are_ignored(self):
        self.assertEqual(len(config.parse(self.text).peers), 1)

    def test_multiple_peers_are_kept_separate(self):
        _, second = keys()
        text = self.text + f"\n[Peer]\nPublicKey = {second}\nAllowedIPs = 10.9.0.4/32\n"
        parsed = config.parse(text)
        self.assertEqual(len(parsed.peers), 2)
        self.assertNotEqual(parsed.peers[0].public_key, parsed.peers[1].public_key)


class ClientConfig(unittest.TestCase):
    def test_endpoint_and_full_tunnel(self):
        private, _ = keys()
        _, server = keys()
        parsed = config.parse(
            f"""
            [Interface]
            PrivateKey = {private}
            Address = 10.9.0.2/24
            DNS = 1.1.1.1, 9.9.9.9

            [Peer]
            PublicKey = {server}
            Endpoint = vpn.example.com:51820
            AllowedIPs = 0.0.0.0/0
            PresharedKey = {encode_key(crypto.random_bytes(32))}
            """
        )
        peer = parsed.peers[0]
        self.assertEqual(peer.endpoint, ("vpn.example.com", 51820))
        self.assertTrue(peer.routes_everything)
        self.assertIsNotNone(peer.preshared_key)
        self.assertEqual(parsed.interface.dns, ["1.1.1.1", "9.9.9.9"])

    def test_endpoint_without_a_port_uses_the_default(self):
        private, _ = keys()
        _, server = keys()
        parsed = config.parse(
            f"[Interface]\nPrivateKey={private}\nAddress=10.9.0.2/24\n"
            f"[Peer]\nPublicKey={server}\nEndpoint=vpn.example.com\nAllowedIPs=0.0.0.0/0\n"
        )
        self.assertEqual(parsed.peers[0].endpoint, ("vpn.example.com", config.DEFAULT_PORT))


class Rejections(unittest.TestCase):
    def setUp(self):
        self.private, _ = keys()
        _, self.public = keys()

    def parse(self, text):
        return config.parse(text)

    def test_missing_interface_section(self):
        with self.assertRaisesRegex(ConfigError, "no .Interface. section"):
            self.parse(f"[Peer]\nPublicKey={self.public}\nAllowedIPs=0.0.0.0/0\n")

    def test_missing_private_key(self):
        with self.assertRaisesRegex(ConfigError, "privatekey"):
            self.parse("[Interface]\nAddress=10.9.0.1/24\n")

    def test_invalid_base64_key(self):
        with self.assertRaisesRegex(ConfigError, "base64"):
            self.parse("[Interface]\nPrivateKey=not-base64!\nAddress=10.9.0.1/24\n")

    def test_key_of_the_wrong_length(self):
        with self.assertRaisesRegex(ConfigError, "32 bytes"):
            self.parse(
                f"[Interface]\nPrivateKey={encode_key(b'short' * 3)}\nAddress=10.9.0.1/24\n"
            )

    def test_host_address_without_a_subnet(self):
        with self.assertRaisesRegex(ConfigError, "prefix"):
            self.parse(f"[Interface]\nPrivateKey={self.private}\nAddress=10.9.0.1/32\n")

    def test_no_peers(self):
        with self.assertRaisesRegex(ConfigError, "no peers"):
            self.parse(f"[Interface]\nPrivateKey={self.private}\nAddress=10.9.0.1/24\n")

    def test_peer_without_allowed_ips(self):
        with self.assertRaisesRegex(ConfigError, "AllowedIPs"):
            self.parse(
                f"[Interface]\nPrivateKey={self.private}\nAddress=10.9.0.1/24\n"
                f"[Peer]\nPublicKey={self.public}\n"
            )

    def test_duplicate_peer_keys(self):
        with self.assertRaisesRegex(ConfigError, "duplicate"):
            self.parse(
                f"[Interface]\nPrivateKey={self.private}\nAddress=10.9.0.1/24\n"
                f"[Peer]\nPublicKey={self.public}\nAllowedIPs=10.9.0.2/32\n"
                f"[Peer]\nPublicKey={self.public}\nAllowedIPs=10.9.0.3/32\n"
            )

    def test_duplicate_interface_sections(self):
        with self.assertRaisesRegex(ConfigError, "duplicate"):
            self.parse(
                f"[Interface]\nPrivateKey={self.private}\nAddress=10.9.0.1/24\n"
                f"[Interface]\nPrivateKey={self.private}\nAddress=10.9.0.9/24\n"
            )

    def test_unknown_section(self):
        with self.assertRaisesRegex(ConfigError, "unknown section"):
            self.parse("[Nonsense]\nKey = value\n")

    def test_setting_before_any_section(self):
        with self.assertRaisesRegex(ConfigError, "outside of any section"):
            self.parse("PrivateKey = x\n")

    def test_line_without_an_equals_sign(self):
        with self.assertRaisesRegex(ConfigError, "expected"):
            self.parse(f"[Interface]\nPrivateKey {self.private}\n")

    def test_error_messages_carry_a_line_number(self):
        with self.assertRaisesRegex(ConfigError, "line 2"):
            self.parse("[Interface]\nnonsense\n")

    def test_bad_allowed_ips(self):
        with self.assertRaisesRegex(ConfigError, "not an IPv4 network"):
            self.parse(
                f"[Interface]\nPrivateKey={self.private}\nAddress=10.9.0.1/24\n"
                f"[Peer]\nPublicKey={self.public}\nAllowedIPs=banana\n"
            )

    def test_bad_boolean(self):
        with self.assertRaisesRegex(ConfigError, "boolean"):
            self.parse(
                f"[Interface]\nPrivateKey={self.private}\nAddress=10.9.0.1/24\nNAT=maybe\n"
                f"[Peer]\nPublicKey={self.public}\nAllowedIPs=0.0.0.0/0\n"
            )


class Files(unittest.TestCase):
    def test_a_missing_file_reports_its_path(self):
        with self.assertRaisesRegex(ConfigError, "no-such-file"):
            config.load("/nonexistent/no-such-file.conf")

    def test_errors_name_the_file(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "broken.conf"
            path.write_text("[Interface]\nAddress = 10.0.0.1/24\n")
            with self.assertRaisesRegex(ConfigError, "broken.conf"):
                config.load(path)


if __name__ == "__main__":
    unittest.main()
