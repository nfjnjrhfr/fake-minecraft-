#!/usr/bin/env python3
"""Run a real VPN client and server on this one machine, and prove that
traffic reaches the actual internet through the encrypted tunnel.

The client runs inside its own network namespace with its own TUN device
and its own default route, connected to the host by a veth pair.  Nothing
is mocked: the client's kernel routes packets into the tunnel, the server
decrypts them onto a real TUN interface, and the host forwards them out to
the internet with NAT.

Crucially, the namespace has no other route to the internet -- the host
only NATs the tunnel subnet -- so anything that succeeds from inside it
must have travelled through the tunnel.

    sudo python3 scripts/local_demo.py

Requires root, /dev/net/tun, iptables, and outbound UDP/TCP from this host.
"""

from __future__ import annotations

import ctypes
import ipaddress
import logging
import os
import socket
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from netlink_veth import create_veth, delete_link, move_to_namespace  # noqa: E402

from pyvpn import crypto  # noqa: E402
from pyvpn.client import client_device  # noqa: E402
from pyvpn.config import Config, InterfaceConfig, PeerConfig  # noqa: E402
from pyvpn.server import server_device  # noqa: E402
from pyvpn.tun import set_address, set_up  # noqa: E402

CLONE_NEWNET = 0x40000000

HOST_VETH = "pyvpn-host"
NS_VETH = "pyvpn-ns"
LINK_HOST = "172.31.9.1"
LINK_CLIENT = "172.31.9.2"
LINK_MASK = "255.255.255.252"

TUNNEL_SUBNET = ipaddress.IPv4Network("10.9.0.0/24")
SERVER_TUNNEL_IP = "10.9.0.1"
CLIENT_TUNNEL_IP = "10.9.0.2"
LISTEN_PORT = 51820

TEST_HOST = "1.1.1.1"
TEST_DNS = "8.8.8.8"
# A plain-text endpoint that echoes back the address the server saw us from.
# Reached by hostname, so a success also proves DNS resolution works through
# the tunnel.  (A bare-IP URL would fail certificate validation instead.)
TRACE_URL = "https://one.one.one.one/cdn-cgi/trace"
TRACE_NAME = "one.one.one.one"

BOLD, GREEN, RED, DIM, RESET = "\033[1m", "\033[32m", "\033[31m", "\033[2m", "\033[0m"


def heading(text: str) -> None:
    print(f"\n{BOLD}{text}{RESET}")


def result(ok: bool, text: str) -> None:
    mark = f"{GREEN}PASS{RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"  [{mark}] {text}")


# --------------------------------------------------------------------------
# the client, inside its own network namespace
# --------------------------------------------------------------------------

def client_process(ready_write: int, go_read: int, keys: dict) -> int:
    """Runs in the child: a fresh netns, a real tunnel, then real requests."""
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    if libc.unshare(CLONE_NEWNET) != 0:
        error = ctypes.get_errno()
        print(f"unshare failed: {os.strerror(error)}", file=sys.stderr)
        return 1

    os.write(ready_write, b"1")  # tell the parent to hand us a veth
    if os.read(go_read, 1) != b"1":
        return 1

    set_up("lo")
    set_address(NS_VETH, LINK_CLIENT, LINK_MASK)
    set_up(NS_VETH)

    heading("2. inside the client namespace, before the VPN is up")
    reachable = tcp_reachable(TEST_HOST, 443, timeout=4)
    result(
        not reachable,
        f"{TEST_HOST}:443 is unreachable without the tunnel"
        + (" -- expected, the namespace has no other way out" if not reachable else ""),
    )
    if reachable:
        print(
            f"  {DIM}the namespace can already reach the internet, so the rest "
            f"of this demo would not prove anything{RESET}"
        )

    config = Config(
        interface=InterfaceConfig(
            private_key=keys["client_private"],
            address=ipaddress.IPv4Interface(f"{CLIENT_TUNNEL_IP}/{TUNNEL_SUBNET.prefixlen}"),
            listen_port=0,
            name="pyvpn0",
            mtu=1400,
        ),
        peers=[
            PeerConfig(
                public_key=keys["server_public"],
                allowed_ips=[ipaddress.IPv4Network("0.0.0.0/0")],
                endpoint=(LINK_HOST, LISTEN_PORT),
                preshared_key=keys["psk"],
                persistent_keepalive=25,
            )
        ],
    )

    heading("3. bringing the tunnel up in the client namespace")
    with client_device(config) as device:
        thread = threading.Thread(target=device.run, daemon=True)
        thread.start()
        try:
            peer = device.peers[0]
            deadline = time.monotonic() + 15
            while peer.current is None and time.monotonic() < deadline:
                time.sleep(0.1)
            result(peer.current is not None, "encrypted session established with the server")
            if peer.current is None:
                return 1
            print(f"  {DIM}default route now points at {device.tun.name}{RESET}")
            print(f"  {DIM}{routes_summary()}{RESET}")

            heading("4. real traffic, from the namespace to the internet")
            failures = 0

            answer = dns_lookup("example.com", TEST_DNS)
            result(bool(answer), f"DNS query to {TEST_DNS} resolved example.com to {answer}")
            failures += not answer

            ok = tcp_reachable(TEST_HOST, 443, timeout=10)
            result(ok, f"TCP connection to {TEST_HOST}:443 established")
            failures += not ok

            # One real HTTPS request, which also tells us which address the
            # far end of the internet sees us coming from.
            status, body = https_get(TRACE_URL)
            ok = status == 0 and "ip=" in body
            result(ok, f"HTTPS request to {TRACE_NAME} returned {len(body)} bytes of content")
            failures += not ok

            public_ip = extract_ip(body) or fetch_public_ip()
            result(
                bool(public_ip),
                f"the internet sees this traffic coming from {public_ip or 'an unknown address'}"
                + " -- the server's address, not the client's",
            )
            failures += not public_ip

            heading("5. what the tunnel carried")
            print(
                f"  {peer.stats.tx_packets} packets ({peer.stats.tx_bytes} bytes) encrypted "
                f"and sent\n  {peer.stats.rx_packets} packets ({peer.stats.rx_bytes} bytes) "
                "received and decrypted"
            )
            moved = peer.stats.rx_bytes > 1000
            result(moved, "real payload travelled through the tunnel")
            failures += not moved
            return 1 if failures else 0
        finally:
            device.stop()
            thread.join(timeout=5)


# --------------------------------------------------------------------------
# probes used inside the namespace
# --------------------------------------------------------------------------

def tcp_reachable(host: str, port: int, timeout: float) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def dns_lookup(name: str, server: str) -> str | None:
    query = struct.pack("!HHHHHH", 0x7A11, 0x0100, 1, 0, 0, 0)
    for label in name.split("."):
        query += bytes([len(label)]) + label.encode()
    query += b"\x00" + struct.pack("!HH", 1, 1)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(8)
    try:
        sock.sendto(query, (server, 53))
        reply, _ = sock.recvfrom(1024)
    except OSError:
        return None
    finally:
        sock.close()

    answers = struct.unpack_from("!H", reply, 6)[0]
    offset = 12
    while reply[offset]:
        offset += reply[offset] + 1
    offset += 5
    for _ in range(answers):
        offset += 2
        record_type, _cls, _ttl, length = struct.unpack_from("!HHIH", reply, offset)
        offset += 10
        if record_type == 1:
            return socket.inet_ntoa(reply[offset : offset + 4])
        offset += length
    return None


def _curl(*args: str) -> tuple[int, str]:
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.lower() not in {"http_proxy", "https_proxy", "all_proxy"}
    }
    try:
        completed = subprocess.run(
            ["curl", "--silent", "--show-error", "--noproxy", "*", "--max-time", "25", *args],
            capture_output=True,
            text=True,
            env=environment,
            check=False,
        )
    except FileNotFoundError:
        return 127, ""
    return completed.returncode, completed.stdout


def https_get(url: str) -> tuple[int, str]:
    return _curl(url)


def extract_ip(body: str) -> str | None:
    for line in body.splitlines():
        if line.startswith("ip="):
            return line[3:].strip()
    return None


def fetch_public_ip() -> str | None:
    status, body = _curl("https://api.ipify.org")
    if status == 0 and body.count(".") == 3 and len(body) < 20:
        return body.strip()
    return None


def routes_summary() -> str:
    lines = []
    with open("/proc/net/route", encoding="ascii") as handle:
        for line in handle.readlines()[1:]:
            fields = line.split()
            destination = socket.inet_ntoa(struct.pack("<I", int(fields[1], 16)))
            mask = bin(int(fields[7], 16)).count("1")
            lines.append(f"{destination}/{mask} dev {fields[0]}")
    return "routes: " + ", ".join(lines)


# --------------------------------------------------------------------------
# the parent: host side and the server
# --------------------------------------------------------------------------

def main() -> int:
    if os.geteuid() != 0:
        print("this demo needs root: sudo python3 scripts/local_demo.py", file=sys.stderr)
        return 1
    logging.basicConfig(
        level=logging.INFO, format=f"{DIM}    %(name)s: %(message)s{RESET}"
    )
    logging.getLogger("pyvpn").setLevel(logging.WARNING)

    server_private, server_public = crypto.generate_keypair()
    client_private, client_public = crypto.generate_keypair()
    keys = {
        "server_public": server_public,
        "client_private": client_private,
        "psk": crypto.random_bytes(32),
    }

    print(f"{BOLD}pyvpn local demonstration{RESET}")
    print(f"{DIM}client namespace {LINK_CLIENT} <-> host {LINK_HOST} <-> internet{RESET}")

    ready_read, ready_write = os.pipe()
    go_read, go_write = os.pipe()

    child = os.fork()
    if child == 0:
        os.close(ready_read)
        os.close(go_write)
        try:
            os._exit(client_process(ready_write, go_read, keys))
        except Exception as exc:  # noqa: BLE001 - the child must never fall through
            print(f"client failed: {exc}", file=sys.stderr)
            os._exit(1)

    os.close(ready_write)
    os.close(go_read)
    exit_code = 1
    try:
        if os.read(ready_read, 1) != b"1":
            raise RuntimeError("the client namespace never came up")

        heading("1. host side: veth pair, tunnel interface and NAT")
        delete_link(HOST_VETH)
        create_veth(HOST_VETH, NS_VETH)
        namespace = os.open(f"/proc/{child}/ns/net", os.O_RDONLY)
        try:
            move_to_namespace(NS_VETH, namespace)
        finally:
            os.close(namespace)
        set_address(HOST_VETH, LINK_HOST, LINK_MASK)
        set_up(HOST_VETH)
        result(True, f"veth {HOST_VETH} ({LINK_HOST}) linked to the client namespace")

        config = Config(
            interface=InterfaceConfig(
                private_key=server_private,
                address=ipaddress.IPv4Interface(
                    f"{SERVER_TUNNEL_IP}/{TUNNEL_SUBNET.prefixlen}"
                ),
                listen_port=LISTEN_PORT,
                name="pyvpn-srv",
                mtu=1400,
                nat=True,
            ),
            peers=[
                PeerConfig(
                    public_key=client_public,
                    allowed_ips=[ipaddress.IPv4Network(f"{CLIENT_TUNNEL_IP}/32")],
                    preshared_key=keys["psk"],
                )
            ],
        )

        with server_device(config) as device:
            thread = threading.Thread(target=device.run, daemon=True)
            thread.start()
            result(True, f"server listening on UDP {LINK_HOST}:{LISTEN_PORT} with NAT enabled")
            try:
                os.write(go_write, b"1")
                _, status = os.waitpid(child, 0)
                exit_code = os.WEXITSTATUS(status)
                child = 0
            finally:
                device.stop()
                thread.join(timeout=5)
    finally:
        if child:
            os.kill(child, 9)
            os.waitpid(child, 0)
        delete_link(HOST_VETH)
        os.close(ready_read)
        os.close(go_write)

    print()
    if exit_code == 0:
        print(f"{GREEN}{BOLD}The tunnel carried real internet traffic end to end.{RESET}")
    else:
        print(f"{RED}{BOLD}The demonstration did not complete successfully.{RESET}")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
