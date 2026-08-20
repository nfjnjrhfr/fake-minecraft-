"""TUN device creation and interface configuration.

Everything here talks to the kernel through ioctl on a scratch UDP socket
rather than shelling out to ``ip``/``ifconfig``, so the tunnel comes up on
minimal images that ship no iproute2 at all.
"""

from __future__ import annotations

import ctypes
import fcntl
import os
import socket
import struct

IFF_TUN = 0x0001
IFF_NO_PI = 0x1000
IFF_UP = 0x1
IFF_RUNNING = 0x40
IFNAMSIZ = 16

TUNSETIFF = 0x400454CA
TUNSETPERSIST = 0x400454CB
SIOCGIFFLAGS = 0x8913
SIOCSIFFLAGS = 0x8914
SIOCSIFADDR = 0x8916
SIOCSIFDSTADDR = 0x8918
SIOCSIFNETMASK = 0x891C
SIOCSIFMTU = 0x8922
SIOCADDRT = 0x890B
SIOCDELRT = 0x890C

RTF_UP = 0x0001
RTF_GATEWAY = 0x0002
RTF_HOST = 0x0004

TUN_DEVICE = "/dev/net/tun"
ROUTE_TABLE = "/proc/net/route"


class NetworkConfigError(OSError):
    """Raised when the kernel refuses an interface or route change."""


class _SockAddrIn(ctypes.Structure):
    _fields_ = [
        ("sin_family", ctypes.c_ushort),
        ("sin_port", ctypes.c_ushort),
        ("sin_addr", ctypes.c_uint32),
        ("sin_zero", ctypes.c_char * 8),
    ]


class _RtEntry(ctypes.Structure):
    """``struct rtentry`` from <linux/route.h>."""

    _fields_ = [
        ("rt_pad1", ctypes.c_ulong),
        ("rt_dst", _SockAddrIn),
        ("rt_gateway", _SockAddrIn),
        ("rt_genmask", _SockAddrIn),
        ("rt_flags", ctypes.c_ushort),
        ("rt_pad2", ctypes.c_short),
        ("rt_pad3", ctypes.c_ulong),
        ("rt_pad4", ctypes.c_void_p),
        ("rt_metric", ctypes.c_short),
        ("rt_dev", ctypes.c_char_p),
        ("rt_mtu", ctypes.c_ulong),
        ("rt_window", ctypes.c_ulong),
        ("rt_irtt", ctypes.c_ushort),
    ]


def _sockaddr(address: str) -> _SockAddrIn:
    sa = _SockAddrIn()
    sa.sin_family = socket.AF_INET
    sa.sin_port = 0
    sa.sin_addr = struct.unpack("<I", socket.inet_aton(address))[0]
    return sa


def _ifreq_addr(name: str, address: str) -> bytes:
    return name.encode().ljust(IFNAMSIZ, b"\x00") + struct.pack(
        "<HH4s8s", socket.AF_INET, 0, socket.inet_aton(address), b"\x00" * 8
    )


class TunDevice:
    """A layer-3 tunnel interface.

    Reads yield bare IP packets and writes inject them, because the device
    is opened with ``IFF_NO_PI`` (no 4-byte packet-info prefix).
    """

    def __init__(self, name: str = "vpn0", mtu: int = 1400) -> None:
        if len(name) >= IFNAMSIZ:
            raise ValueError(f"interface name must be under {IFNAMSIZ} characters")
        self.requested_name = name
        self.mtu = mtu
        self.fd = -1
        self.name = name

    def open(self) -> "TunDevice":
        try:
            self.fd = os.open(TUN_DEVICE, os.O_RDWR)
        except FileNotFoundError as exc:
            raise NetworkConfigError(
                f"{TUN_DEVICE} is missing; load the tun module (modprobe tun)"
            ) from exc
        except PermissionError as exc:
            raise NetworkConfigError(
                f"cannot open {TUN_DEVICE}; run as root or grant CAP_NET_ADMIN"
            ) from exc

        ifr = struct.pack(
            f"{IFNAMSIZ}sH22s",
            self.requested_name.encode(),
            IFF_TUN | IFF_NO_PI,
            b"",
        )
        try:
            result = fcntl.ioctl(self.fd, TUNSETIFF, ifr)
        except OSError as exc:
            os.close(self.fd)
            self.fd = -1
            raise NetworkConfigError(f"TUNSETIFF failed: {exc}") from exc
        self.name = result[:IFNAMSIZ].rstrip(b"\x00").decode()
        # Non-blocking so the event loop can drain a burst of packets without
        # stalling on the last read.
        flags = fcntl.fcntl(self.fd, fcntl.F_GETFL)
        fcntl.fcntl(self.fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        return self

    # -- configuration ---------------------------------------------------

    def configure(self, address: str, netmask: str) -> None:
        """Assign an address, set the MTU and bring the interface up."""
        set_address(self.name, address, netmask)
        set_mtu(self.name, self.mtu)
        set_up(self.name)

    # -- I/O -------------------------------------------------------------

    def read(self, size: int = 65535) -> bytes:
        return os.read(self.fd, size)

    def write(self, packet: bytes) -> int:
        return os.write(self.fd, packet)

    def fileno(self) -> int:
        return self.fd

    def close(self) -> None:
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1

    def __enter__(self) -> "TunDevice":
        return self.open()

    def __exit__(self, *exc_info) -> None:
        self.close()


def _control_socket():
    return socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def _ioctl(request: int, payload, what: str) -> bytes:
    with _control_socket() as sock:
        try:
            return fcntl.ioctl(sock.fileno(), request, payload)
        except OSError as exc:
            raise NetworkConfigError(f"failed to {what}: {exc}") from exc


# --------------------------------------------------------------------------
# interface configuration
#
# These operate by name, so they work for any interface, not just the tunnel:
# the same calls configure a veth pair or bring up loopback.
# --------------------------------------------------------------------------

def set_address(name: str, address: str, netmask: str) -> None:
    _ioctl(SIOCSIFADDR, _ifreq_addr(name, address), f"set the address of {name}")
    _ioctl(SIOCSIFNETMASK, _ifreq_addr(name, netmask), f"set the netmask of {name}")


def set_mtu(name: str, mtu: int) -> None:
    payload = name.encode().ljust(IFNAMSIZ, b"\x00") + struct.pack("<i", mtu) + b"\x00" * 12
    _ioctl(SIOCSIFMTU, payload, f"set the MTU of {name}")


def get_flags(name: str) -> int:
    request = name.encode().ljust(IFNAMSIZ, b"\x00") + b"\x00" * 16
    result = _ioctl(SIOCGIFFLAGS, request, f"read the flags of {name}")
    (flags,) = struct.unpack_from("<H", result, IFNAMSIZ)
    return flags


def set_up(name: str) -> None:
    flags = get_flags(name) | IFF_UP | IFF_RUNNING
    payload = name.encode().ljust(IFNAMSIZ, b"\x00") + struct.pack("<H", flags) + b"\x00" * 14
    _ioctl(SIOCSIFFLAGS, payload, f"bring {name} up")


# --------------------------------------------------------------------------
# routing
# --------------------------------------------------------------------------

def add_route(
    destination: str,
    netmask: str,
    *,
    device: str | None = None,
    gateway: str | None = None,
    metric: int = 0,
) -> None:
    """Install an IPv4 route, either via a device or via a gateway."""
    _route_ioctl(SIOCADDRT, destination, netmask, device, gateway, metric, "add")


def delete_route(
    destination: str,
    netmask: str,
    *,
    device: str | None = None,
    gateway: str | None = None,
    metric: int = 0,
) -> None:
    _route_ioctl(SIOCDELRT, destination, netmask, device, gateway, metric, "delete")


def _route_ioctl(request, destination, netmask, device, gateway, metric, verb):
    route = _RtEntry()
    route.rt_dst = _sockaddr(destination)
    route.rt_genmask = _sockaddr(netmask)
    route.rt_flags = RTF_UP
    if gateway:
        route.rt_gateway = _sockaddr(gateway)
        route.rt_flags |= RTF_GATEWAY
    else:
        route.rt_gateway = _sockaddr("0.0.0.0")
    if netmask == "255.255.255.255":
        route.rt_flags |= RTF_HOST
    if device:
        route.rt_dev = device.encode()
    route.rt_metric = metric + 1  # the kernel stores metric+1 for this API

    _ioctl(request, route, f"{verb} route {destination}/{netmask}")


def default_gateway(table: str = ROUTE_TABLE) -> tuple[str, str] | None:
    """Return ``(gateway, interface)`` for the current default route.

    Read straight out of ``/proc/net/route`` so it works without iproute2.
    Returns ``None`` when the host has no default route.
    """
    try:
        with open(table, "r", encoding="ascii") as handle:
            lines = handle.readlines()[1:]
    except OSError:
        return None

    for line in lines:
        fields = line.split()
        if len(fields) < 8:
            continue
        interface, destination, gateway, flags = fields[0], fields[1], fields[2], int(fields[3], 16)
        if destination != "00000000" or not flags & RTF_UP:
            continue
        if not flags & RTF_GATEWAY:
            continue
        address = socket.inet_ntoa(struct.pack("<I", int(gateway, 16)))
        return address, interface
    return None


def on_link_route(address: str, table: str = ROUTE_TABLE) -> str | None:
    """Return the interface a non-default route already covers ``address`` on.

    Used to tell whether the VPN server is on a directly connected network,
    in which case pinning a host route to a gateway is unnecessary -- the
    connected route is more specific than the tunnel's split default anyway.
    """
    target = int.from_bytes(socket.inet_aton(address), "little")
    try:
        with open(table, "r", encoding="ascii") as handle:
            lines = handle.readlines()[1:]
    except OSError:
        return None

    best_prefix = -1
    best_interface = None
    for line in lines:
        fields = line.split()
        if len(fields) < 8:
            continue
        interface, destination, flags, mask = (
            fields[0], fields[1], int(fields[3], 16), fields[7]
        )
        if not flags & RTF_UP or destination == "00000000":
            continue
        netmask = int(mask, 16)
        if (target & netmask) != (int(destination, 16) & netmask):
            continue
        prefix = bin(netmask).count("1")
        if prefix > best_prefix:
            best_prefix, best_interface = prefix, interface
    return best_interface


def primary_interface(table: str = ROUTE_TABLE) -> str | None:
    """Best guess at the interface facing the internet."""
    found = default_gateway(table)
    if found:
        return found[1]
    try:
        with open(table, "r", encoding="ascii") as handle:
            for line in handle.readlines()[1:]:
                fields = line.split()
                if fields and fields[0] != "lo":
                    return fields[0]
    except OSError:
        pass
    return None
