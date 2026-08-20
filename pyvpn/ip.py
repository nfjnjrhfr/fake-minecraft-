"""Minimal IPv4 header inspection.

Only what cryptokey routing needs: who a packet claims to be from, where it
is going, and how long it really is (so trailing padding can be trimmed).
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass

IPV4_HEADER_LEN = 20


@dataclass(frozen=True)
class IPv4Header:
    source: ipaddress.IPv4Address
    destination: ipaddress.IPv4Address
    total_length: int
    protocol: int


def version(packet: bytes) -> int:
    if not packet:
        return 0
    return packet[0] >> 4


def parse_ipv4(packet: bytes) -> IPv4Header | None:
    """Parse an IPv4 header, or return ``None`` if the packet is not usable."""
    if len(packet) < IPV4_HEADER_LEN or packet[0] >> 4 != 4:
        return None
    total_length = int.from_bytes(packet[2:4], "big")
    if total_length < IPV4_HEADER_LEN or total_length > len(packet):
        return None
    return IPv4Header(
        source=ipaddress.IPv4Address(packet[12:16]),
        destination=ipaddress.IPv4Address(packet[16:20]),
        total_length=total_length,
        protocol=packet[9],
    )


def trim(packet: bytes) -> bytes:
    """Strip transport padding using the length recorded in the IP header."""
    header = parse_ipv4(packet)
    if header is None:
        return packet
    return packet[: header.total_length]
