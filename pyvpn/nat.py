"""Server-side forwarding and NAT.

This is what turns the tunnel into an actual route to the internet: packets
that arrive from a client are forwarded out of the server's WAN interface
with their source address rewritten, so replies come back to the server and
then down the tunnel.

Every rule installed here is remembered and removed again on shutdown, so a
stopped server leaves the host's firewall as it found it.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("pyvpn.nat")

IP_FORWARD = Path("/proc/sys/net/ipv4/ip_forward")


class NatError(RuntimeError):
    """Raised when forwarding or NAT cannot be configured."""


@dataclass(frozen=True)
class Rule:
    table: str
    chain: str
    args: tuple[str, ...]

    def command(self, action: str) -> list[str]:
        return ["iptables", "-t", self.table, action, self.chain, *self.args]


class Forwarding:
    """Installs (and later removes) the rules that let clients reach the internet."""

    def __init__(self, tunnel_interface: str, subnet: str, wan_interface: str) -> None:
        self.tunnel_interface = tunnel_interface
        self.subnet = subnet
        self.wan_interface = wan_interface
        self._installed: list[Rule] = []
        self._previous_ip_forward: str | None = None

    def rules(self) -> list[Rule]:
        return [
            # Rewrite client source addresses to the server's WAN address.
            Rule(
                "nat",
                "POSTROUTING",
                ("-s", self.subnet, "-o", self.wan_interface, "-j", "MASQUERADE"),
            ),
            # Let tunnel traffic out ...
            Rule(
                "filter",
                "FORWARD",
                ("-i", self.tunnel_interface, "-s", self.subnet, "-j", "ACCEPT"),
            ),
            # ... and let replies to it back in.
            Rule(
                "filter",
                "FORWARD",
                (
                    "-o",
                    self.tunnel_interface,
                    "-d",
                    self.subnet,
                    "-m",
                    "conntrack",
                    "--ctstate",
                    "RELATED,ESTABLISHED",
                    "-j",
                    "ACCEPT",
                ),
            ),
            # Clamp TCP MSS: the tunnel MTU is smaller than the path MTU, and
            # without this, sites that block ICMP hang instead of failing fast.
            Rule(
                "mangle",
                "FORWARD",
                (
                    "-o",
                    self.tunnel_interface,
                    "-p",
                    "tcp",
                    "--tcp-flags",
                    "SYN,RST",
                    "SYN",
                    "-j",
                    "TCPMSS",
                    "--clamp-mss-to-pmtu",
                ),
            ),
        ]

    # -- lifecycle -------------------------------------------------------

    def enable(self) -> None:
        if shutil.which("iptables") is None:
            raise NatError(
                "iptables is not installed, so client traffic cannot be "
                "forwarded to the internet; install iptables or set NAT = off"
            )
        self._enable_ip_forward()
        for rule in self.rules():
            if self._exists(rule):
                log.debug("rule already present, leaving it alone: %s", rule.args)
                continue
            self._run(rule.command("-I" if rule.chain == "FORWARD" else "-A"))
            self._installed.append(rule)
        log.info(
            "forwarding %s from %s out of %s with NAT",
            self.subnet,
            self.tunnel_interface,
            self.wan_interface,
        )

    def disable(self) -> None:
        while self._installed:
            rule = self._installed.pop()
            try:
                self._run(rule.command("-D"))
            except NatError as exc:
                log.warning("could not remove a firewall rule: %s", exc)
        if self._previous_ip_forward is not None:
            try:
                IP_FORWARD.write_text(self._previous_ip_forward)
            except OSError as exc:
                log.warning("could not restore ip_forward: %s", exc)
            self._previous_ip_forward = None

    def __enter__(self) -> "Forwarding":
        self.enable()
        return self

    def __exit__(self, *exc_info) -> None:
        self.disable()

    # -- helpers ---------------------------------------------------------

    def _enable_ip_forward(self) -> None:
        try:
            current = IP_FORWARD.read_text().strip()
        except OSError as exc:
            raise NatError(f"cannot read {IP_FORWARD}: {exc}") from exc
        if current == "1":
            return
        try:
            IP_FORWARD.write_text("1\n")
        except OSError as exc:
            raise NatError(
                f"cannot enable IPv4 forwarding ({exc}); run as root, or set it "
                "with sysctl -w net.ipv4.ip_forward=1"
            ) from exc
        self._previous_ip_forward = current
        log.info("enabled IPv4 forwarding (was %s)", current)

    def _exists(self, rule: Rule) -> bool:
        result = subprocess.run(
            rule.command("-C"), capture_output=True, text=True, check=False
        )
        return result.returncode == 0

    @staticmethod
    def _run(command: list[str]) -> None:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise NatError(
                f"{' '.join(command)} failed: {result.stderr.strip() or result.stdout.strip()}"
            )
