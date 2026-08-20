"""Tests for route-table inspection and the client's routing plan."""

from __future__ import annotations

import ipaddress
import tempfile
import unittest
from pathlib import Path

import tests.support  # noqa: F401

from pyvpn import tun
from pyvpn.routing import TunnelRoutes

# Columns as the kernel prints them: iface, dest, gateway, flags, refcnt,
# use, metric, mask, mtu, window, irtt.  Addresses are little-endian hex.
ROUTE_TABLE = """Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT
eth0\t00000000\t0102000A\t0003\t0\t0\t0\t00000000\t0\t0\t0
eth0\t000200A0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0
wlan0\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0
"""


class RouteTable(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "route"
        self.path.write_text(ROUTE_TABLE)

    def test_default_gateway_is_found(self):
        self.assertEqual(tun.default_gateway(str(self.path)), ("10.0.2.1", "eth0"))

    def test_primary_interface_follows_the_default_route(self):
        self.assertEqual(tun.primary_interface(str(self.path)), "eth0")

    def test_on_link_addresses_are_recognised(self):
        self.assertEqual(tun.on_link_route("160.0.2.7", str(self.path)), "eth0")
        self.assertEqual(tun.on_link_route("192.168.0.5", str(self.path)), "wlan0")

    def test_remote_addresses_are_not_on_link(self):
        self.assertIsNone(tun.on_link_route("8.8.8.8", str(self.path)))

    def test_the_default_route_does_not_count_as_on_link(self):
        """Otherwise every address would look directly connected."""
        self.assertIsNone(tun.on_link_route("1.2.3.4", str(self.path)))

    def test_a_missing_table_is_handled(self):
        self.assertIsNone(tun.default_gateway("/nonexistent/route"))
        self.assertIsNone(tun.on_link_route("8.8.8.8", "/nonexistent/route"))

    def test_a_table_without_a_default_route(self):
        path = Path(self.directory.name) / "no-default"
        path.write_text("\n".join(ROUTE_TABLE.splitlines()[:1] + ROUTE_TABLE.splitlines()[2:]))
        self.assertIsNone(tun.default_gateway(str(path)))
        self.assertEqual(tun.primary_interface(str(path)), "eth0")


class RoutingPlan(unittest.TestCase):
    def test_a_default_route_is_recognised_as_a_full_tunnel(self):
        routes = TunnelRoutes("vpn0", "203.0.113.5", [ipaddress.IPv4Network("0.0.0.0/0")])
        self.assertTrue(routes.redirects_everything)

    def test_specific_networks_are_a_split_tunnel(self):
        routes = TunnelRoutes(
            "vpn0",
            "203.0.113.5",
            [ipaddress.IPv4Network("10.0.0.0/8"), ipaddress.IPv4Network("192.168.0.0/16")],
        )
        self.assertFalse(routes.redirects_everything)

    def test_the_split_default_covers_the_whole_address_space(self):
        """0.0.0.0/1 and 128.0.0.0/1 must together cover every address."""
        from pyvpn.routing import SPLIT_DEFAULT

        halves = [
            ipaddress.IPv4Network(f"{destination}/{netmask}")
            for destination, netmask in SPLIT_DEFAULT
        ]
        self.assertEqual(sum(half.num_addresses for half in halves), 1 << 32)
        for address in ("0.0.0.0", "8.8.8.8", "127.255.255.255", "128.0.0.0", "255.255.255.255"):
            self.assertTrue(
                any(ipaddress.IPv4Address(address) in half for half in halves), address
            )

    def test_each_half_is_more_specific_than_the_system_default(self):
        from pyvpn.routing import SPLIT_DEFAULT

        for _destination, netmask in SPLIT_DEFAULT:
            network = ipaddress.IPv4Network(f"0.0.0.0/{netmask}", strict=False)
            self.assertGreater(network.prefixlen, 0)

    def test_reverting_without_applying_is_harmless(self):
        TunnelRoutes("vpn0", "203.0.113.5", []).revert()


if __name__ == "__main__":
    unittest.main()
