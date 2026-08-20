"""Helpers shared by the test modules."""

from __future__ import annotations

import ipaddress
import socket
import struct
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pyvpn import crypto  # noqa: E402
from pyvpn.config import Config, InterfaceConfig, PeerConfig  # noqa: E402
from pyvpn.device import Device  # noqa: E402


class LoopbackTun:
    """A stand-in for a real TUN device.

    ``inject`` plays the part of the kernel handing a packet to the tunnel,
    and every packet the device delivers to the host lands in ``written``.
    This lets the whole datapath -- routing, handshake, encryption, replay
    checks -- be exercised without root or a real interface.
    """

    def __init__(self, name: str = "test0") -> None:
        self.name = name
        # SOCK_DGRAM preserves packet boundaries, exactly as a TUN device
        # does; a stream pair would silently coalesce packets.
        self._host, self._device = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
        for end in (self._host, self._device):
            end.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4 << 20)
            end.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
        self._device.setblocking(False)
        self.written: list[bytes] = []
        self._lock = threading.Lock()
        self._arrived = threading.Condition(self._lock)

    def fileno(self) -> int:
        return self._device.fileno()

    def read(self, size: int = 65535) -> bytes:
        return self._device.recv(size)

    def write(self, packet: bytes) -> int:
        with self._arrived:
            self.written.append(packet)
            self._arrived.notify_all()
        return len(packet)

    def inject(self, packet: bytes) -> None:
        self._host.send(packet)

    def wait_for(self, count: int, timeout: float = 5.0) -> list[bytes]:
        with self._arrived:
            self._arrived.wait_for(lambda: len(self.written) >= count, timeout=timeout)
            return list(self.written)

    def close(self) -> None:
        self._host.close()
        self._device.close()


def ipv4_packet(source: str, destination: str, payload: bytes = b"ping") -> bytes:
    """Build a syntactically valid IPv4/UDP packet."""
    udp = struct.pack("!HHHH", 4000, 4001, 8 + len(payload), 0) + payload
    total = 20 + len(udp)
    header = struct.pack(
        "!BBHHHBBH4s4s",
        0x45,
        0,
        total,
        0x1234,
        0,
        64,
        socket.IPPROTO_UDP,
        0,
        socket.inet_aton(source),
        socket.inet_aton(destination),
    )
    return header + udp


def make_config(private_key: bytes, address: str, port: int, peers: list[PeerConfig]) -> Config:
    return Config(
        interface=InterfaceConfig(
            private_key=private_key,
            address=ipaddress.IPv4Interface(address),
            listen_port=port,
        ),
        peers=peers,
    )


def udp_socket(port: int = 0) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", port))
    sock.setblocking(False)
    return sock


class SpySocket:
    """Wraps a socket to record every datagram sent through it.

    ``socket`` objects do not allow attribute assignment, so tests that need
    to inspect the wire wrap one of these around the real socket.
    """

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self.sent: list[bytes] = []

    def sendto(self, data, address):
        self.sent.append(bytes(data))
        return self._sock.sendto(data, address)

    def data_packets(self) -> list[bytes]:
        from pyvpn.messages import MSG_DATA

        return [packet for packet in self.sent if packet and packet[0] == MSG_DATA]

    def __getattr__(self, name):
        return getattr(self._sock, name)


class RunningDevice:
    """A :class:`~pyvpn.device.Device` running on its own thread."""

    def __init__(self, device: Device) -> None:
        self.device = device
        self.thread = threading.Thread(target=device.run, daemon=True)

    def __enter__(self) -> Device:
        self.thread.start()
        return self.device

    def __exit__(self, *exc_info) -> None:
        self.device.stop()
        self.thread.join(timeout=5)


def peer_pair():
    """Return ``(server_keys, client_keys, preshared_key)``."""
    return crypto.generate_keypair(), crypto.generate_keypair(), crypto.random_bytes(32)
