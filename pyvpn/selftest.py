"""A self-contained check that the tunnel actually works on this machine.

Runs both ends of a tunnel inside one process over loopback UDP, pushes a
packet through it, and confirms the packet came out intact and that what
travelled on the wire was ciphertext.  When run as root it additionally
creates a real TUN interface to prove the kernel side is available too.
"""

from __future__ import annotations

import ipaddress
import os
import socket
import struct
import threading
import time

from . import crypto
from .config import Config, InterfaceConfig, PeerConfig
from .device import Device
from .messages import MSG_DATA

TEST_SUBNET = "10.99.0.0/24"
SERVER_IP = "10.99.0.1"
CLIENT_IP = "10.99.0.2"
PROBE = b"pyvpn selftest payload"


class MemoryInterface:
    """A tunnel interface backed by a socket pair instead of the kernel."""

    def __init__(self, name: str) -> None:
        self.name = name
        self._host, self._device = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
        self._device.setblocking(False)
        self.written: list[bytes] = []
        self._arrived = threading.Condition()

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

    def wait_for(self, count: int, timeout: float = 10.0) -> bool:
        with self._arrived:
            return self._arrived.wait_for(lambda: len(self.written) >= count, timeout)

    def close(self) -> None:
        self._host.close()
        self._device.close()


class RecordingSocket:
    """Passes datagrams through while keeping a copy for inspection."""

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self.sent: list[bytes] = []

    def sendto(self, data, address):
        self.sent.append(bytes(data))
        return self._sock.sendto(data, address)

    def __getattr__(self, name):
        return getattr(self._sock, name)


def _udp_socket() -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 0))
    sock.setblocking(False)
    return sock


def _icmp_echo(source: str, destination: str, payload: bytes) -> bytes:
    body = struct.pack("!BBHHH", 8, 0, 0, 0x1234, 1) + payload
    total = 20 + len(body)
    header = struct.pack(
        "!BBHHHBBH4s4s",
        0x45, 0, total, 0xBEEF, 0, 64, socket.IPPROTO_ICMP, 0,
        socket.inet_aton(source), socket.inet_aton(destination),
    )
    return header + body


def run_selftest(verbose: bool = True) -> int:
    failures: list[str] = []

    def report(name: str, ok: bool, detail: str = "") -> None:
        if not ok:
            failures.append(name)
        if verbose:
            mark = "ok  " if ok else "FAIL"
            print(f"[{mark}] {name}{'  -- ' + detail if detail else ''}")

    # 1. Cryptography ------------------------------------------------------
    if verbose:
        note = "" if crypto.backend == "cryptography" else \
            "  (pure Python -- fine for this test, not for real traffic)"
        print(f"backend: {crypto.backend}{note}\n")
    a_private, a_public = crypto.generate_keypair()
    b_private, b_public = crypto.generate_keypair()
    report(
        "X25519 key agreement",
        crypto.dh(a_private, b_public) == crypto.dh(b_private, a_public),
    )
    key = crypto.random_bytes(32)
    sealed = crypto.aead_encrypt(key, 7, PROBE, b"header")
    report(
        "ChaCha20-Poly1305 round trip",
        crypto.aead_decrypt(key, 7, sealed, b"header") == PROBE,
    )
    tampered = bytearray(sealed)
    tampered[0] ^= 0xFF
    try:
        crypto.aead_decrypt(key, 7, bytes(tampered), b"header")
        report("tampered ciphertext rejected", False, "forgery was accepted")
    except Exception:  # noqa: BLE001 - any rejection is the correct outcome
        report("tampered ciphertext rejected", True)

    # 2. A live tunnel between two in-process endpoints ---------------------
    server_sock = _udp_socket()
    client_sock = RecordingSocket(_udp_socket())
    server_tun = MemoryInterface("selftest-server")
    client_tun = MemoryInterface("selftest-client")
    port = server_sock.getsockname()[1]
    psk = crypto.random_bytes(32)

    def config_for(private, address, listen_port, peers):
        return Config(
            interface=InterfaceConfig(
                private_key=private,
                address=ipaddress.IPv4Interface(address),
                listen_port=listen_port,
            ),
            peers=peers,
        )

    server = Device(
        config_for(
            a_private,
            f"{SERVER_IP}/24",
            port,
            [
                PeerConfig(
                    public_key=b_public,
                    allowed_ips=[ipaddress.IPv4Network(f"{CLIENT_IP}/32")],
                    preshared_key=psk,
                )
            ],
        ),
        server_tun,
        server_sock,
    )
    client = Device(
        config_for(
            b_private,
            f"{CLIENT_IP}/24",
            client_sock.getsockname()[1],
            [
                PeerConfig(
                    public_key=a_public,
                    allowed_ips=[ipaddress.IPv4Network("0.0.0.0/0")],
                    endpoint=("127.0.0.1", port),
                    preshared_key=psk,
                )
            ],
        ),
        client_tun,
        client_sock,
    )

    threads = [
        threading.Thread(target=device.run, daemon=True) for device in (server, client)
    ]
    try:
        for thread in threads:
            thread.start()

        outbound = _icmp_echo(CLIENT_IP, "1.1.1.1", PROBE)
        client_tun.inject(outbound)
        arrived = server_tun.wait_for(1)
        report(
            "handshake and outbound packet",
            arrived and server_tun.written[0] == outbound,
            "" if arrived else "nothing came out of the server side",
        )

        reply = _icmp_echo("1.1.1.1", CLIENT_IP, PROBE)
        server_tun.inject(reply)
        back = client_tun.wait_for(1)
        report(
            "return traffic through the tunnel",
            back and client_tun.written[0] == reply,
            "" if back else "no reply reached the client",
        )

        data_packets = [p for p in client_sock.sent if p and p[0] == MSG_DATA]
        report("payload encrypted on the wire", bool(data_packets) and all(
            PROBE not in packet for packet in client_sock.sent
        ))

        replayed = data_packets[-1] if data_packets else None
        if replayed:
            before = len(server_tun.written)
            client_sock.sendto(replayed, ("127.0.0.1", port))
            time.sleep(0.5)
            report("replayed packet rejected", len(server_tun.written) == before)

        peer = client.peers[0]
        report(
            "session established",
            peer.current is not None,
            f"handshakes: {peer.stats.handshakes}",
        )
    finally:
        for device in (server, client):
            device.stop()
        for thread in threads:
            thread.join(timeout=5)
        server_tun.close()
        client_tun.close()
        server_sock.close()
        client_sock.close()

    # 3. The kernel side, when we are allowed to touch it --------------------
    # Not every platform that can run the checks above has geteuid: iOS
    # Python builds are the case that matters here, and there is certainly no
    # root there, so treat its absence as "not privileged".
    if getattr(os, "geteuid", lambda: -1)() == 0:
        from .tun import NetworkConfigError, TunDevice

        try:
            device_ = TunDevice("pyvpn-test", mtu=1400).open()
            try:
                device_.configure("10.98.0.1", "255.255.255.0")
                report("real TUN interface created and configured", True, device_.name)
            finally:
                device_.close()
        except NetworkConfigError as exc:
            report("real TUN interface created and configured", False, str(exc))
    elif verbose:
        print("[skip] real TUN interface (needs root)")

    if verbose:
        print()
        print(
            "All checks passed."
            if not failures
            else f"{len(failures)} check(s) failed: {', '.join(failures)}"
        )
    return 1 if failures else 0
