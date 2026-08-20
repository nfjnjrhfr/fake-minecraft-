"""Client-side routing: sending the host's traffic through the tunnel.

Rather than deleting the system default route and hoping to restore it, we
install two half-of-the-internet routes -- ``0.0.0.0/1`` and
``128.0.0.0/1`` -- which are more specific than ``0.0.0.0/0`` and therefore
win, while the original default route stays untouched underneath.  A host
route pins the VPN server itself to the real gateway, otherwise the
encrypted packets would try to route through the tunnel they create.
"""

from __future__ import annotations

import ipaddress
import logging
import socket

from .tun import (
    NetworkConfigError,
    add_route,
    default_gateway,
    delete_route,
    on_link_route,
)

log = logging.getLogger("pyvpn.routing")

SPLIT_DEFAULT = (("0.0.0.0", "128.0.0.0"), ("128.0.0.0", "128.0.0.0"))


class RoutingError(RuntimeError):
    """Raised when the tunnel routes cannot be installed."""


def resolve(host: str) -> str:
    """Resolve an endpoint host to an IPv4 address."""
    try:
        return socket.gethostbyname(host)
    except OSError as exc:
        raise RoutingError(f"cannot resolve VPN server address {host!r}: {exc}") from exc


class TunnelRoutes:
    """Installs the routes a client needs, and takes them away again."""

    def __init__(
        self,
        interface: str,
        server_address: str,
        networks: list[ipaddress.IPv4Network],
    ) -> None:
        self.interface = interface
        self.server_address = server_address
        self.networks = networks
        self._added: list[dict] = []

    @property
    def redirects_everything(self) -> bool:
        return any(network.prefixlen == 0 for network in self.networks)

    def apply(self) -> None:
        try:
            if self.redirects_everything:
                self._pin_server_route()
                for destination, netmask in SPLIT_DEFAULT:
                    self._add(destination, netmask, device=self.interface)
                log.info("all IPv4 traffic now leaves through %s", self.interface)
            else:
                for network in self.networks:
                    self._add(
                        str(network.network_address),
                        str(network.netmask),
                        device=self.interface,
                    )
                log.info(
                    "routing %s through %s",
                    ", ".join(str(net) for net in self.networks),
                    self.interface,
                )
        except NetworkConfigError:
            self.revert()
            raise

    def _pin_server_route(self) -> None:
        """Keep the encrypted packets themselves off the tunnel."""
        address = ipaddress.IPv4Address(self.server_address)
        if address.is_loopback:
            log.debug("server is on loopback; no host route needed")
            return
        on_link = on_link_route(self.server_address)
        if on_link is not None:
            # The connected route to the server's network is more specific
            # than the tunnel's two half-default routes, so it already wins.
            log.info(
                "VPN server %s is directly reachable on %s; no host route needed",
                self.server_address,
                on_link,
            )
            return
        found = default_gateway()
        if found is None:
            raise RoutingError(
                "this host has no default route, so there is no way to reach "
                f"the VPN server at {self.server_address} once the tunnel takes over"
            )
        gateway, device = found
        self._add(
            self.server_address, "255.255.255.255", gateway=gateway, device=device
        )
        log.info("pinned %s to gateway %s via %s", self.server_address, gateway, device)

    def _add(self, destination: str, netmask: str, **kwargs) -> None:
        add_route(destination, netmask, **kwargs)
        self._added.append({"destination": destination, "netmask": netmask, **kwargs})

    def revert(self) -> None:
        while self._added:
            route = self._added.pop()
            destination = route.pop("destination")
            netmask = route.pop("netmask")
            try:
                delete_route(destination, netmask, **route)
            except NetworkConfigError as exc:
                log.warning("could not remove route %s: %s", destination, exc)

    def __enter__(self) -> "TunnelRoutes":
        self.apply()
        return self

    def __exit__(self, *exc_info) -> None:
        self.revert()
