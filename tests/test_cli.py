"""Tests for the command line interface."""

from __future__ import annotations

import io
import contextlib
import tempfile
import unittest
from pathlib import Path

import tests.support  # noqa: F401

from pyvpn import config, crypto
from pyvpn.cli import main


def run(*argv) -> tuple[int, str]:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = main(list(argv))
    return code, out.getvalue()


class KeyCommands(unittest.TestCase):
    def test_genkey_prints_a_usable_private_key(self):
        code, output = run("genkey")
        self.assertEqual(code, 0)
        key = config.decode_key(output.strip(), "key")
        self.assertEqual(len(key), 32)

    def test_genkey_is_not_deterministic(self):
        self.assertNotEqual(run("genkey")[1], run("genkey")[1])

    def test_genpsk_prints_32_bytes(self):
        _, output = run("genpsk")
        self.assertEqual(len(config.decode_key(output.strip(), "psk")), 32)

    def test_pubkey_derives_the_matching_public_key(self):
        import sys

        private, public = crypto.generate_keypair()
        original = sys.stdin
        sys.stdin = io.StringIO(config.encode_key(private))
        try:
            _, output = run("pubkey")
        finally:
            sys.stdin = original
        self.assertEqual(output.strip(), config.encode_key(public))


class Init(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name) / "conf"

    def generate(self, *extra):
        return run(
            "init", "--endpoint", "vpn.example.com:51820",
            "--output", str(self.output), *extra,
        )

    def test_the_generated_pair_is_valid_and_consistent(self):
        code, _ = self.generate("--clients", "2")
        self.assertEqual(code, 0)

        server = config.load(self.output / "server.conf")
        clients = [config.load(self.output / f"client{n}.conf") for n in (1, 2)]

        server_public = crypto.public_from_private(server.interface.private_key)
        for client in clients:
            # Each client points at the server ...
            self.assertEqual(client.peers[0].public_key, server_public)
            # ... and the server knows that client.
            client_public = crypto.public_from_private(client.interface.private_key)
            matching = [peer for peer in server.peers if peer.public_key == client_public]
            self.assertEqual(len(matching), 1)
            # ... and both agree on the pre-shared key.
            self.assertEqual(matching[0].preshared_key, client.peers[0].preshared_key)

    def test_addresses_are_unique_and_inside_the_subnet(self):
        self.generate("--clients", "3", "--subnet", "10.44.0.0/24")
        addresses = {
            config.load(self.output / f"client{n}.conf").interface.address.ip
            for n in (1, 2, 3)
        }
        self.assertEqual(len(addresses), 3)
        server = config.load(self.output / "server.conf")
        for address in addresses:
            self.assertIn(address, server.interface.address.network)
            self.assertNotEqual(address, server.interface.address.ip)

    def test_the_server_routes_each_client_only_to_its_own_address(self):
        self.generate("--clients", "2")
        server = config.load(self.output / "server.conf")
        for peer in server.peers:
            self.assertEqual(len(peer.allowed_ips), 1)
            self.assertEqual(peer.allowed_ips[0].prefixlen, 32)

    def test_clients_get_a_full_tunnel_by_default(self):
        self.generate()
        client = config.load(self.output / "client1.conf")
        self.assertTrue(client.peers[0].routes_everything)
        self.assertEqual(client.peers[0].persistent_keepalive, 25)

    def test_the_server_enables_nat(self):
        self.generate()
        self.assertTrue(config.load(self.output / "server.conf").interface.nat)

    def test_files_are_not_world_readable(self):
        """They contain private keys."""
        self.generate()
        for name in ("server.conf", "client1.conf"):
            mode = (self.output / name).stat().st_mode & 0o777
            self.assertEqual(mode, 0o600, name)

    def test_the_psk_layer_can_be_turned_off(self):
        self.generate("--no-psk")
        self.assertIsNone(config.load(self.output / "client1.conf").peers[0].preshared_key)

    def test_dns_is_passed_through(self):
        self.generate("--dns", "9.9.9.9")
        self.assertEqual(config.load(self.output / "client1.conf").interface.dns, ["9.9.9.9"])

    def test_a_subnet_that_is_too_small_is_reported(self):
        with self.assertRaises(SystemExit) as raised:
            self.generate("--clients", "500", "--subnet", "10.0.0.0/24")
        self.assertEqual(raised.exception.code, 2)


class Show(unittest.TestCase):
    def test_a_configuration_is_summarised(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "conf"
            run("init", "--endpoint", "vpn.example.com", "--output", str(output))
            code, text = run("show", "-c", str(output / "client1.conf"))
        self.assertEqual(code, 0)
        self.assertIn("allowed ips: 0.0.0.0/0", text)
        self.assertIn("endpoint: vpn.example.com:51820", text)
        self.assertIn("preshared key: yes", text)

    def test_a_broken_configuration_exits_with_an_error(self):
        with self.assertRaises(SystemExit) as raised:
            run("show", "-c", "/nonexistent/nothing.conf")
        self.assertEqual(raised.exception.code, 2)


class Selftest(unittest.TestCase):
    def test_the_selftest_passes(self):
        code, _ = run("selftest", "--quiet")
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
