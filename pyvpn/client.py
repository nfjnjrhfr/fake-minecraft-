"""The client end of the tunnel.

Brings up the interface, points the host's routes at it, and then runs the
same engine the server does.  With ``AllowedIPs = 0.0.0.0/0`` the result is
a full-tunnel VPN: every packet this host sends is encrypted, handed to the
server, and forwarded to the real internet from there.
"""

from __future__ import annotations

import contextlib
import logging

from .config import Config, ConfigError
from .device import Device
from .resolver import Resolver
from .routing import TunnelRoutes, resolve
from .server import bind_socket
from .tun import TunDevice

log = logging.getLogger("pyvpn.client")


@contextlib.contextmanager
def client_device(config: Config):
    """Bring up everything a client needs and yield the running device."""
    interface = config.interface
    server_peer = _find_server_peer(config)
    server_host, server_port = server_peer.endpoint
    server_address = resolve(server_host)
    if server_address != server_host:
        log.info("resolved %s to %s", server_host, server_address)
    server_peer.endpoint = (server_address, server_port)

    tun = TunDevice(interface.name, interface.mtu).open()
    stack = contextlib.ExitStack()
    stack.callback(tun.close)
    try:
        tun.configure(str(interface.address.ip), str(interface.address.netmask))
        log.info(
            "interface %s is up with address %s (MTU %d)",
            tun.name,
            interface.address,
            interface.mtu,
        )

        # A client does not need a fixed port; 0 lets the kernel pick one.
        sock = bind_socket(interface.listen_port)
        stack.callback(sock.close)

        routes = TunnelRoutes(
            tun.name,
            server_address,
            [network for peer in config.peers for network in peer.allowed_ips],
        )
        routes.apply()
        stack.callback(routes.revert)

        resolver = Resolver(interface.dns)
        resolver.apply()
        stack.callback(resolver.revert)

        device = Device(config, tun, sock)
        # Do not wait for the first packet: bring the session up now, so the
        # tunnel is ready before anything tries to use it.
        for peer in device.peers:
            if peer.endpoint is not None:
                device.start_handshake(peer)
        yield device
    finally:
        stack.close()
        log.info("client shut down and host configuration restored")


def _find_server_peer(config: Config):
    candidates = [peer for peer in config.peers if peer.endpoint is not None]
    if not candidates:
        raise ConfigError(
            "a client configuration needs a [Peer] with an Endpoint to connect to"
        )
    if len(candidates) > 1:
        log.warning(
            "%d peers have endpoints; using the first for routing decisions",
            len(candidates),
        )
    return candidates[0]


def run(config: Config) -> None:
    from .server import _install_signal_handlers

    with client_device(config) as device:
        _install_signal_handlers(device)
        device.run()
