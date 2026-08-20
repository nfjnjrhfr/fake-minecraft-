"""Wire format for tunnel packets.

Every datagram on the wire starts with a one-byte type and three reserved
bytes, which keeps the rest of every message 4-byte aligned.

    initiation  (148 bytes)
        type(1) reserved(3) sender(4) ephemeral(32)
        enc_static(48) enc_timestamp(28) mac1(16) mac2(16)

    response    (92 bytes)
        type(1) reserved(3) sender(4) receiver(4) ephemeral(32)
        enc_empty(16) mac1(16) mac2(16)

    type 3 is reserved for a cookie reply, which is not implemented; such
    packets are recognised and ignored.

    data        (16 + payload + 16 bytes)
        type(1) reserved(3) receiver(4) counter(8) enc_payload(N+16)

The data header is authenticated as associated data, so a receiver index or
counter cannot be rewritten in flight.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

MSG_INITIATION = 1
MSG_RESPONSE = 2
MSG_COOKIE = 3
MSG_DATA = 4

RESERVED = b"\x00\x00\x00"

INITIATION_LEN = 148
RESPONSE_LEN = 92
DATA_HEADER_LEN = 16
DATA_OVERHEAD = DATA_HEADER_LEN + 16  # header + Poly1305 tag

_HEADER = struct.Struct("<B3s")


class MalformedPacket(ValueError):
    """Raised when a datagram cannot be parsed as a tunnel message."""


def message_type(packet: bytes) -> int:
    if len(packet) < 4:
        raise MalformedPacket("packet shorter than the fixed header")
    return packet[0]


@dataclass(frozen=True)
class Initiation:
    sender: int
    ephemeral: bytes
    enc_static: bytes
    enc_timestamp: bytes
    mac1: bytes = b"\x00" * 16
    mac2: bytes = b"\x00" * 16

    def to_bytes(self) -> bytes:
        return (
            _HEADER.pack(MSG_INITIATION, RESERVED)
            + struct.pack("<I", self.sender)
            + self.ephemeral
            + self.enc_static
            + self.enc_timestamp
            + self.mac1
            + self.mac2
        )

    @property
    def mac1_input(self) -> bytes:
        """The prefix mac1 is computed over (everything before mac1)."""
        return self.to_bytes()[: INITIATION_LEN - 32]

    @classmethod
    def from_bytes(cls, raw: bytes) -> "Initiation":
        if len(raw) != INITIATION_LEN:
            raise MalformedPacket(
                f"initiation must be {INITIATION_LEN} bytes, got {len(raw)}"
            )
        if raw[0] != MSG_INITIATION:
            raise MalformedPacket("not an initiation message")
        (sender,) = struct.unpack_from("<I", raw, 4)
        return cls(
            sender=sender,
            ephemeral=raw[8:40],
            enc_static=raw[40:88],
            enc_timestamp=raw[88:116],
            mac1=raw[116:132],
            mac2=raw[132:148],
        )


@dataclass(frozen=True)
class Response:
    sender: int
    receiver: int
    ephemeral: bytes
    enc_empty: bytes
    mac1: bytes = b"\x00" * 16
    mac2: bytes = b"\x00" * 16

    def to_bytes(self) -> bytes:
        return (
            _HEADER.pack(MSG_RESPONSE, RESERVED)
            + struct.pack("<II", self.sender, self.receiver)
            + self.ephemeral
            + self.enc_empty
            + self.mac1
            + self.mac2
        )

    @property
    def mac1_input(self) -> bytes:
        return self.to_bytes()[: RESPONSE_LEN - 32]

    @classmethod
    def from_bytes(cls, raw: bytes) -> "Response":
        if len(raw) != RESPONSE_LEN:
            raise MalformedPacket(
                f"response must be {RESPONSE_LEN} bytes, got {len(raw)}"
            )
        if raw[0] != MSG_RESPONSE:
            raise MalformedPacket("not a response message")
        sender, receiver = struct.unpack_from("<II", raw, 4)
        return cls(
            sender=sender,
            receiver=receiver,
            ephemeral=raw[12:44],
            enc_empty=raw[44:60],
            mac1=raw[60:76],
            mac2=raw[76:92],
        )


def data_header(receiver: int, counter: int) -> bytes:
    """Build the 16-byte data header, which doubles as AEAD associated data."""
    return (
        _HEADER.pack(MSG_DATA, RESERVED)
        + struct.pack("<I", receiver)
        + struct.pack("<Q", counter)
    )


def parse_data_header(raw: bytes) -> tuple[int, int]:
    """Return ``(receiver, counter)`` for a data packet."""
    if len(raw) < DATA_HEADER_LEN + 16:
        raise MalformedPacket("data packet shorter than header plus tag")
    if raw[0] != MSG_DATA:
        raise MalformedPacket("not a data message")
    (receiver,) = struct.unpack_from("<I", raw, 4)
    (counter,) = struct.unpack_from("<Q", raw, 8)
    return receiver, counter
