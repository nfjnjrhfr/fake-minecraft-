"""Cryptographic primitives for the tunnel.

The handshake is the Noise_IKpsk2 pattern instantiated with
X25519 / ChaCha20-Poly1305 / BLAKE2s, i.e. the same construction WireGuard
uses.  This implementation follows that design but uses its own protocol
identifier and its own wire format, so it is *not* interoperable with
WireGuard -- do not point a WireGuard client at it.

Properties the handshake gives us:

  * mutual authentication of both static keys,
  * forward secrecy (each session uses fresh ephemeral keys),
  * identity hiding for the initiator (its static key is encrypted),
  * key-compromise impersonation resistance,
  * optional post-quantum-ish hardening via a pre-shared symmetric key,
  * replay protection for handshake initiations (monotonic timestamps).
"""

from __future__ import annotations

import hashlib
import hmac as _hmac
import os
import time

# The compiled cryptography package is used when present. When it is not --
# on a stock Python with nothing installable, such as an iOS terminal -- the
# pure-Python backend takes over. Both produce identical bytes; the pure one
# is not constant-time, so it is meant for self-tests and learning, not for
# guarding real traffic. `backend` records which one is active.
try:
    from cryptography.hazmat.primitives.asymmetric.x25519 import (
        X25519PrivateKey,
        X25519PublicKey,
    )
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
    from cryptography.exceptions import InvalidTag

    backend = "cryptography"
except ImportError:  # pragma: no cover - exercised on hosts without the library
    from . import purecrypto as _pure
    from .purecrypto import InvalidTag

    X25519PrivateKey = X25519PublicKey = ChaCha20Poly1305 = None
    backend = "pure-python"

__all__ = [
    "InvalidTag",
    "backend",
    "KEY_LEN",
    "TAG_LEN",
    "ZERO_KEY",
    "aead_decrypt",
    "aead_encrypt",
    "dh",
    "generate_keypair",
    "hash_",
    "kdf",
    "mac",
    "public_from_private",
    "tai64n",
]

KEY_LEN = 32
TAG_LEN = 16
MAC_LEN = 16
TIMESTAMP_LEN = 12
ZERO_KEY = b"\x00" * KEY_LEN

CONSTRUCTION = b"Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s"
IDENTIFIER = b"pyvpn v1 encrypted tunnel"
LABEL_MAC1 = b"pyvpn mac1----"


# --------------------------------------------------------------------------
# hashing / key derivation
# --------------------------------------------------------------------------

def hash_(*chunks: bytes) -> bytes:
    """BLAKE2s-256 over the concatenation of ``chunks``."""
    h = hashlib.blake2s(digest_size=32)
    for chunk in chunks:
        h.update(chunk)
    return h.digest()


def mac(key: bytes, data: bytes) -> bytes:
    """Keyed BLAKE2s-128, used for the cheap anti-DoS packet cookie."""
    return hashlib.blake2s(data, digest_size=MAC_LEN, key=key).digest()


def _hmac_blake2s(key: bytes, data: bytes) -> bytes:
    return _hmac.new(key, data, hashlib.blake2s).digest()


def kdf(key: bytes, data: bytes, outputs: int) -> list[bytes]:
    """HKDF-BLAKE2s, returning ``outputs`` 32-byte keys."""
    if not 1 <= outputs <= 255:
        raise ValueError("outputs must be in 1..255")
    prk = _hmac_blake2s(key, data)
    result: list[bytes] = []
    previous = b""
    for counter in range(1, outputs + 1):
        previous = _hmac_blake2s(prk, previous + bytes([counter]))
        result.append(previous)
    return result


# --------------------------------------------------------------------------
# Diffie-Hellman
# --------------------------------------------------------------------------

def generate_keypair() -> tuple[bytes, bytes]:
    """Return ``(private, public)`` as raw 32-byte X25519 keys."""
    if backend == "cryptography":
        private = X25519PrivateKey.generate()
        return _private_bytes(private), _public_bytes(private.public_key())
    private = os.urandom(32)
    return private, _pure.x25519_base(private)


def public_from_private(private: bytes) -> bytes:
    if backend == "cryptography":
        return _public_bytes(X25519PrivateKey.from_private_bytes(private).public_key())
    return _pure.x25519_base(private)


def dh(private: bytes, peer_public: bytes) -> bytes:
    """X25519 shared secret.

    Raises :class:`ValueError` when the peer contributed a low-order point,
    which would otherwise yield an all-zero shared secret that both an
    attacker and we can predict.
    """
    if backend == "cryptography":
        shared = X25519PrivateKey.from_private_bytes(private).exchange(
            X25519PublicKey.from_public_bytes(peer_public)
        )
    else:
        shared = _pure.x25519(private, peer_public)
    if not any(shared):
        raise ValueError("peer supplied a low-order X25519 public key")
    return shared


def _private_bytes(key: X25519PrivateKey) -> bytes:
    from cryptography.hazmat.primitives import serialization

    return key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )


def _public_bytes(key: X25519PublicKey) -> bytes:
    from cryptography.hazmat.primitives import serialization

    return key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )


# --------------------------------------------------------------------------
# AEAD
# --------------------------------------------------------------------------

def _nonce(counter: int) -> bytes:
    if not 0 <= counter < (1 << 64):
        raise ValueError("nonce counter out of range")
    # 4 zero bytes followed by the little-endian counter, as in RFC 7539
    # style constructions used by WireGuard.
    return b"\x00" * 4 + counter.to_bytes(8, "little")


def aead_encrypt(key: bytes, counter: int, plaintext: bytes, aad: bytes) -> bytes:
    if backend == "cryptography":
        return ChaCha20Poly1305(key).encrypt(_nonce(counter), plaintext, aad)
    return _pure.chacha20poly1305_encrypt(key, _nonce(counter), plaintext, aad)


def aead_decrypt(key: bytes, counter: int, ciphertext: bytes, aad: bytes) -> bytes:
    if backend == "cryptography":
        return ChaCha20Poly1305(key).decrypt(_nonce(counter), ciphertext, aad)
    return _pure.chacha20poly1305_decrypt(key, _nonce(counter), ciphertext, aad)


def random_bytes(count: int) -> bytes:
    return os.urandom(count)


# --------------------------------------------------------------------------
# timestamps
# --------------------------------------------------------------------------

def tai64n(now: float | None = None) -> bytes:
    """A 12-byte TAI64N timestamp.

    Used as the initiator's replay counter: the responder remembers the
    greatest timestamp seen per peer and rejects anything not strictly
    greater, so a captured initiation cannot be replayed.
    """
    if now is None:
        now = time.time()
    seconds = int(now)
    nanos = int((now - seconds) * 1_000_000_000)
    return (0x400000000000000A + seconds).to_bytes(8, "big") + nanos.to_bytes(4, "big")
