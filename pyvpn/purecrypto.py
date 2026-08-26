"""Pure-Python X25519 and ChaCha20-Poly1305, for hosts without the
``cryptography`` package.

The point of this module is reach, not speed: it lets the tunnel's handshake
and encryption run on a stock Python with nothing installed -- an iOS
terminal such as a-Shell, for instance -- where a compiled library cannot be
added. Every routine here follows its RFC (7748 for X25519, 8439 for
ChaCha20-Poly1305) and is checked byte-for-byte against the compiled library
in the test suite.

A warning that belongs in the code, not just the docs: none of this is
constant-time. A pure-Python bignum ladder leaks timing, so this backend is
right for a self-test or for learning, and wrong for guarding real traffic
against an attacker who can measure you. When ``cryptography`` is present,
``crypto.py`` uses it instead and this file is never imported.
"""

from __future__ import annotations

import struct

# ---------------------------------------------------------------------------
# X25519 (RFC 7748)
# ---------------------------------------------------------------------------

_P = 2 ** 255 - 19
_A24 = 121665


def _decode_scalar(scalar: bytes) -> int:
    k = bytearray(scalar)
    k[0] &= 248
    k[31] &= 127
    k[31] |= 64
    return int.from_bytes(k, "little")


def _decode_u(u: bytes) -> int:
    # The high bit of the last byte is unused and must be masked off.
    data = bytearray(u)
    data[31] &= 127
    return int.from_bytes(data, "little")


def _mul(scalar: int, u: int) -> int:
    """The Montgomery ladder from RFC 7748, section 5."""
    x1 = u
    x2, z2 = 1, 0
    x3, z3 = u, 1
    swap = 0
    for t in range(254, -1, -1):
        bit = (scalar >> t) & 1
        swap ^= bit
        # Conditional swap, written branch-free for clarity rather than for
        # timing -- this backend makes no timing promise anyway.
        if swap:
            x2, x3 = x3, x2
            z2, z3 = z3, z2
        swap = bit

        a = (x2 + z2) % _P
        b = (x2 - z2) % _P
        c = (x3 + z3) % _P
        d = (x3 - z3) % _P
        da = (d * a) % _P
        cb = (c * b) % _P
        x3 = pow(da + cb, 2, _P)
        z3 = (x1 * pow(da - cb, 2, _P)) % _P
        aa = (a * a) % _P
        bb = (b * b) % _P
        x2 = (aa * bb) % _P
        e = (aa - bb) % _P
        z2 = (e * (aa + _A24 * e)) % _P

    if swap:
        x2, x3 = x3, x2
        z2, z3 = z3, z2
    return (x2 * pow(z2, _P - 2, _P)) % _P


def x25519(scalar: bytes, u: bytes) -> bytes:
    result = _mul(_decode_scalar(scalar), _decode_u(u))
    return result.to_bytes(32, "little")


_BASE_POINT = (9).to_bytes(32, "little")


def x25519_base(scalar: bytes) -> bytes:
    return x25519(scalar, _BASE_POINT)


# ---------------------------------------------------------------------------
# ChaCha20 (RFC 8439, section 2.4)
# ---------------------------------------------------------------------------

_MASK32 = 0xFFFFFFFF


def _rotl(value: int, count: int) -> int:
    value &= _MASK32
    return ((value << count) | (value >> (32 - count))) & _MASK32


def _quarter_round(state: list[int], a: int, b: int, c: int, d: int) -> None:
    state[a] = (state[a] + state[b]) & _MASK32
    state[d] = _rotl(state[d] ^ state[a], 16)
    state[c] = (state[c] + state[d]) & _MASK32
    state[b] = _rotl(state[b] ^ state[c], 12)
    state[a] = (state[a] + state[b]) & _MASK32
    state[d] = _rotl(state[d] ^ state[a], 8)
    state[c] = (state[c] + state[d]) & _MASK32
    state[b] = _rotl(state[b] ^ state[c], 7)


_CONSTANTS = (0x61707865, 0x3320646E, 0x79622D32, 0x6B206574)  # "expand 32-byte k"


def _chacha20_block(key: bytes, counter: int, nonce: bytes) -> bytes:
    state = list(_CONSTANTS)
    state += list(struct.unpack("<8I", key))
    state.append(counter & _MASK32)
    state += list(struct.unpack("<3I", nonce))

    working = state[:]
    for _ in range(10):  # 20 rounds = 10 column rounds + 10 diagonal rounds
        _quarter_round(working, 0, 4, 8, 12)
        _quarter_round(working, 1, 5, 9, 13)
        _quarter_round(working, 2, 6, 10, 14)
        _quarter_round(working, 3, 7, 11, 15)
        _quarter_round(working, 0, 5, 10, 15)
        _quarter_round(working, 1, 6, 11, 12)
        _quarter_round(working, 2, 7, 8, 13)
        _quarter_round(working, 3, 4, 9, 14)
    out = [(working[i] + state[i]) & _MASK32 for i in range(16)]
    return struct.pack("<16I", *out)


def _chacha20(key: bytes, counter: int, nonce: bytes, data: bytes) -> bytes:
    out = bytearray(len(data))
    for offset in range(0, len(data), 64):
        block = _chacha20_block(key, counter + offset // 64, nonce)
        chunk = data[offset : offset + 64]
        for i, byte in enumerate(chunk):
            out[offset + i] = byte ^ block[i]
    return bytes(out)


# ---------------------------------------------------------------------------
# Poly1305 (RFC 8439, section 2.5)
# ---------------------------------------------------------------------------

_POLY_P = (1 << 130) - 5


def _poly1305_mac(key: bytes, message: bytes) -> bytes:
    r = int.from_bytes(key[:16], "little") & 0x0FFFFFFC0FFFFFFC0FFFFFFC0FFFFFFF
    s = int.from_bytes(key[16:32], "little")
    acc = 0
    for offset in range(0, len(message), 16):
        chunk = message[offset : offset + 16]
        n = int.from_bytes(chunk + b"\x01", "little")
        acc = ((acc + n) * r) % _POLY_P
    acc = (acc + s) & ((1 << 128) - 1)
    return acc.to_bytes(16, "little")


def _pad16(data: bytes) -> bytes:
    if len(data) % 16 == 0:
        return b""
    return b"\x00" * (16 - len(data) % 16)


def _poly_key(key: bytes, nonce: bytes) -> bytes:
    # The one-time Poly1305 key is the first ChaCha20 block, counter 0.
    return _chacha20_block(key, 0, nonce)[:32]


def _tag(key: bytes, nonce: bytes, ciphertext: bytes, aad: bytes) -> bytes:
    mac_data = (
        aad + _pad16(aad)
        + ciphertext + _pad16(ciphertext)
        + struct.pack("<Q", len(aad))
        + struct.pack("<Q", len(ciphertext))
    )
    return _poly1305_mac(_poly_key(key, nonce), mac_data)


class InvalidTag(Exception):
    """Raised when a ChaCha20-Poly1305 tag does not verify."""


def chacha20poly1305_encrypt(key: bytes, nonce: bytes, plaintext: bytes, aad: bytes) -> bytes:
    ciphertext = _chacha20(key, 1, nonce, plaintext)
    return ciphertext + _tag(key, nonce, ciphertext, aad)


def chacha20poly1305_decrypt(key: bytes, nonce: bytes, ciphertext: bytes, aad: bytes) -> bytes:
    if len(ciphertext) < 16:
        raise InvalidTag("ciphertext shorter than its tag")
    body, tag = ciphertext[:-16], ciphertext[-16:]
    expected = _tag(key, nonce, body, aad)
    # hmac.compare_digest keeps the comparison itself constant-time even
    # though the arithmetic above is not.
    import hmac

    if not hmac.compare_digest(expected, tag):
        raise InvalidTag("authentication tag mismatch")
    return _chacha20(key, 1, nonce, body)
