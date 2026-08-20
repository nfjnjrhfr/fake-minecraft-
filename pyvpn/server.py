"""The server end of the tunnel.

Responsibilities beyond running the shared engine: bring up the tunnel
interface, and arrange for decrypted client traffic to be forwarded out to
the real internet with NAT, so a client's packets leave the server as if the
server had sent them.
"""

from __future__ import annotations

import contextlib
import logging
import socket

from .config import Config
from .device import Device
from .nat import Forwarding, NatError
from .tun import NetworkConfigError, TunDevice, primary_interface

log = logging.getLogger("pyvpn.server")


def bind_socket(port: int, address: str = "0.0.0.0") -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    # A generous buffer keeps bursts from being dropped before we read them.
    with contextlib.suppress(OSError):
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4 << 20)
    try:
        sock.bind((address, port))
    except OSError as exc:
        sock.close()
        raise NetworkConfigError(f"cannot listen on {address}:{port}: {exc}") from exc
    sock.setblocking(False)
    return sock


@contextlib.contextmanager
def server_device(config: Config):
    """Bring up everything a server needs and yield the running device."""
    interface = config.interface
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

        if interface.nat:
            wan = interface.wan_interface or primary_interface()
            if wan is None:
                raise NatError(
                    "cannot work out which interface faces the internet; "
                    "set WanInterface in the [Interface] section"
                )
            forwarding = Forwarding(tun.name, str(interface.address.network), wan)
            forwarding.enable()
            stack.callback(forwarding.disable)
        else:
            log.warning(
                "NAT is off: clients will reach only what this host already "
                "routes for them, not the wider internet"
            )

        sock = bind_socket(interface.listen_port)
        stack.callback(sock.close)
        log.info("listening for encrypted traffic on UDP port %d", interface.listen_port)

        yield Device(config, tun, sock)
    finally:
        stack.close()
        log.info("server shut down and host configuration restored")


def run(config: Config) -> None:
    with server_device(config) as device:
        _install_signal_handlers(device)
        device.run()


def _install_signal_handlers(device: Device) -> None:
    import signal

    def stop(signum, _frame):
        log.info("received %s, shutting down", signal.Signals(signum).name)
        device.stop()

    def report(_signum, _frame):
        print(device.status(), flush=True)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    with contextlib.suppress(AttributeError, ValueError):
        signal.signal(signal.SIGUSR1, report)
