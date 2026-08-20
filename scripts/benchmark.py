#!/usr/bin/env python3
"""Measure how fast the tunnel moves data on this machine.

Both ends run in one process over loopback UDP, so this measures the cost
of the tunnel itself -- encryption, framing, routing and the event loop --
rather than the speed of any network.  No root required.

    python3 scripts/benchmark.py [--seconds 5] [--size 1372]
"""

from __future__ import annotations

import argparse
import ipaddress
import socket
import struct
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pyvpn import crypto  # noqa: E402
from pyvpn.config import Config, InterfaceConfig, PeerConfig  # noqa: E402
from pyvpn.device import Device  # noqa: E402
from pyvpn.selftest import MemoryInterface  # noqa: E402

SERVER_IP = "10.9.0.1"
CLIENT_IP = "10.9.0.2"


def packet(payload_size: int) -> bytes:
    payload = b"\x5a" * payload_size
    udp = struct.pack("!HHHH", 1234, 5678, 8 + len(payload), 0) + payload
    total = 20 + len(udp)
    header = struct.pack(
        "!BBHHHBBH4s4s", 0x45, 0, total, 1, 0, 64, socket.IPPROTO_UDP, 0,
        socket.inet_aton(CLIENT_IP), socket.inet_aton("8.8.8.8"),
    )
    return header + udp


def socket_pair() -> tuple[socket.socket, socket.socket]:
    sockets = []
    for _ in range(2):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 16 << 20)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 16 << 20)
        sock.bind(("127.0.0.1", 0))
        sock.setblocking(False)
        sockets.append(sock)
    return sockets[0], sockets[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=5.0, help="how long to send for")
    parser.add_argument("--size", type=int, default=1372, help="payload bytes per packet")
    args = parser.parse_args()

    server_private, server_public = crypto.generate_keypair()
    client_private, client_public = crypto.generate_keypair()
    psk = crypto.random_bytes(32)

    server_sock, client_sock = socket_pair()
    server_tun, client_tun = MemoryInterface("bench-server"), MemoryInterface("bench-client")
    port = server_sock.getsockname()[1]

    def configure(private, address, listen_port, peers):
        return Config(
            interface=InterfaceConfig(
                private_key=private,
                address=ipaddress.IPv4Interface(address),
                listen_port=listen_port,
            ),
            peers=peers,
        )

    server = Device(
        configure(server_private, f"{SERVER_IP}/24", port, [
            PeerConfig(
                public_key=client_public,
                allowed_ips=[ipaddress.IPv4Network(f"{CLIENT_IP}/32")],
                preshared_key=psk,
            )
        ]),
        server_tun,
        server_sock,
    )
    client = Device(
        configure(client_private, f"{CLIENT_IP}/24", client_sock.getsockname()[1], [
            PeerConfig(
                public_key=server_public,
                allowed_ips=[ipaddress.IPv4Network("0.0.0.0/0")],
                endpoint=("127.0.0.1", port),
                preshared_key=psk,
            )
        ]),
        client_tun,
        client_sock,
    )

    threads = [threading.Thread(target=device.run, daemon=True) for device in (server, client)]
    for thread in threads:
        thread.start()

    probe = packet(args.size)
    client_tun.inject(probe)
    if not client_tun.wait_for(0) or not server_tun.wait_for(1, timeout=10):
        print("the tunnel did not come up", file=sys.stderr)
        return 1
    print(f"tunnel established; sending {len(probe)}-byte packets for {args.seconds:g}s")

    sent = 0
    started = time.monotonic()
    deadline = started + args.seconds
    while time.monotonic() < deadline:
        for _ in range(64):
            client_tun.inject(probe)
        sent += 64
        # A tiny pause keeps the sender from simply overrunning the socket
        # buffers, which would measure packet loss rather than throughput.
        time.sleep(0.0005)
    send_elapsed = time.monotonic() - started

    # Wait for the pipeline to drain.
    previous = -1
    while previous != len(server_tun.written):
        previous = len(server_tun.written)
        time.sleep(0.3)
    elapsed = time.monotonic() - started

    delivered = len(server_tun.written) - 1
    bits = delivered * len(probe) * 8
    print()
    print(f"  sent:       {sent:,} packets in {send_elapsed:.2f}s")
    print(f"  delivered:  {delivered:,} packets ({delivered / max(sent, 1):.1%})")
    print(f"  throughput: {bits / elapsed / 1e6:,.0f} Mbit/s")
    print(f"  rate:       {delivered / elapsed:,.0f} packets/s")
    print()
    print("  Both tunnel ends share this machine's CPUs, so a real deployment")
    print("  with the two ends on separate hosts sees roughly twice this.")

    for device in (server, client):
        device.stop()
    for thread in threads:
        thread.join(timeout=5)
    server_tun.close()
    client_tun.close()
    server_sock.close()
    client_sock.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
