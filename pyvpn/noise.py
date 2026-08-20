"""The Noise_IKpsk2 handshake, message by message.

Two round trips are never needed: the initiator sends one packet, the
responder answers with one packet, and both sides then hold a fresh pair of
transport keys.  The initiator can already encrypt data after sending its
initiation, but this implementation waits for the response so that it never
sends data under keys the peer has not confirmed.

    initiator                                   responder
    ---------                                   ---------
    e, es, s, ss                 ---->
                                 <----          e, ee, se, psk

Notation follows the Noise spec: ``e``/``s`` are ephemeral/static keys sent,
and ``es``/``ss``/``ee``/``se`` are Diffie-Hellman operations mixed into the
chaining key.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import crypto
from .crypto import InvalidTag
from .messages import Initiation, Response

__all__ = ["HandshakeError", "HandshakeState", "TransportKeys", "mac1_key"]


class HandshakeError(Exception):
    """Raised when a handshake message fails to authenticate."""


@dataclass(frozen=True)
class TransportKeys:
    """Directional keys derived once the handshake completes."""

    send_key: bytes
    recv_key: bytes


def mac1_key(static_public: bytes) -> bytes:
    """The key used to stamp mac1 on messages addressed to ``static_public``.

    Anyone who knows the destination's public key can compute this, so mac1
    is not authentication; it only forces an attacker to know who they are
    talking to before we spend a Curve25519 operation on their packet.
    """
    return crypto.hash_(crypto.LABEL_MAC1, static_public)


def _initial_state(remote_static_public: bytes) -> tuple[bytes, bytes]:
    chaining = crypto.hash_(crypto.CONSTRUCTION)
    hash_ = crypto.hash_(chaining, crypto.IDENTIFIER)
    hash_ = crypto.hash_(hash_, remote_static_public)
    return chaining, hash_


@dataclass
class HandshakeState:
    """One in-flight handshake.

    A state object is used for exactly one handshake attempt and then
    discarded; the ephemeral private key dies with it, which is what gives
    the session forward secrecy.
    """

    local_static_private: bytes
    local_static_public: bytes
    remote_static_public: bytes | None = None
    preshared_key: bytes = crypto.ZERO_KEY
    is_initiator: bool = False

    chaining_key: bytes = b""
    hash: bytes = b""
    ephemeral_private: bytes = b""
    ephemeral_public: bytes = b""
    remote_ephemeral: bytes = b""
    local_index: int = 0
    remote_index: int = 0
    timestamp: bytes = b""
    _mixed: list[str] = field(default_factory=list, repr=False)

    # -- initiator -------------------------------------------------------

    def create_initiation(self, local_index: int) -> Initiation:
        if self.remote_static_public is None:
            raise HandshakeError("initiator must know the responder's public key")
        self.is_initiator = True
        self.local_index = local_index
        self.chaining_key, self.hash = _initial_state(self.remote_static_public)

        self.ephemeral_private, self.ephemeral_public = crypto.generate_keypair()
        (self.chaining_key,) = crypto.kdf(self.chaining_key, self.ephemeral_public, 1)
        self.hash = crypto.hash_(self.hash, self.ephemeral_public)

        # es: hides our static key from anyone who is not the responder.
        self.chaining_key, key = crypto.kdf(
            self.chaining_key, crypto.dh(self.ephemeral_private, self.remote_static_public), 2
        )
        enc_static = crypto.aead_encrypt(key, 0, self.local_static_public, self.hash)
        self.hash = crypto.hash_(self.hash, enc_static)

        # ss: proves we hold the private half of the static key we just sent.
        self.chaining_key, key = crypto.kdf(
            self.chaining_key,
            crypto.dh(self.local_static_private, self.remote_static_public),
            2,
        )
        self.timestamp = crypto.tai64n()
        enc_timestamp = crypto.aead_encrypt(key, 0, self.timestamp, self.hash)
        self.hash = crypto.hash_(self.hash, enc_timestamp)

        message = Initiation(
            sender=local_index,
            ephemeral=self.ephemeral_public,
            enc_static=enc_static,
            enc_timestamp=enc_timestamp,
        )
        return _with_mac1(message, mac1_key(self.remote_static_public))

    def consume_response(self, message: Response) -> TransportKeys:
        if not self.is_initiator:
            raise HandshakeError("only the initiator consumes a response")
        self.remote_index = message.sender
        self.remote_ephemeral = message.ephemeral

        (self.chaining_key,) = crypto.kdf(self.chaining_key, message.ephemeral, 1)
        self.hash = crypto.hash_(self.hash, message.ephemeral)

        # ee then se, mirroring the responder's mixes.
        (self.chaining_key,) = crypto.kdf(
            self.chaining_key, crypto.dh(self.ephemeral_private, message.ephemeral), 1
        )
        (self.chaining_key,) = crypto.kdf(
            self.chaining_key, crypto.dh(self.local_static_private, message.ephemeral), 1
        )

        self.chaining_key, tau, key = crypto.kdf(self.chaining_key, self.preshared_key, 3)
        self.hash = crypto.hash_(self.hash, tau)
        try:
            crypto.aead_decrypt(key, 0, message.enc_empty, self.hash)
        except InvalidTag as exc:
            raise HandshakeError("response failed to authenticate") from exc
        self.hash = crypto.hash_(self.hash, message.enc_empty)

        send_key, recv_key = crypto.kdf(self.chaining_key, b"", 2)
        self._burn()
        return TransportKeys(send_key=send_key, recv_key=recv_key)

    # -- responder -------------------------------------------------------

    def consume_initiation(self, message: Initiation) -> bytes:
        """Validate an initiation and return the initiator's static key."""
        self.is_initiator = False
        self.remote_index = message.sender
        self.chaining_key, self.hash = _initial_state(self.local_static_public)

        (self.chaining_key,) = crypto.kdf(self.chaining_key, message.ephemeral, 1)
        self.hash = crypto.hash_(self.hash, message.ephemeral)
        self.remote_ephemeral = message.ephemeral

        try:
            self.chaining_key, key = crypto.kdf(
                self.chaining_key,
                crypto.dh(self.local_static_private, message.ephemeral),
                2,
            )
            remote_static = crypto.aead_decrypt(key, 0, message.enc_static, self.hash)
        except (InvalidTag, ValueError) as exc:
            raise HandshakeError("initiation static key failed to decrypt") from exc
        self.hash = crypto.hash_(self.hash, message.enc_static)

        if self.remote_static_public is not None and remote_static != self.remote_static_public:
            raise HandshakeError("initiation came from an unexpected static key")
        self.remote_static_public = remote_static

        try:
            self.chaining_key, key = crypto.kdf(
                self.chaining_key,
                crypto.dh(self.local_static_private, remote_static),
                2,
            )
            self.timestamp = crypto.aead_decrypt(key, 0, message.enc_timestamp, self.hash)
        except (InvalidTag, ValueError) as exc:
            raise HandshakeError("initiation timestamp failed to decrypt") from exc
        self.hash = crypto.hash_(self.hash, message.enc_timestamp)
        return remote_static

    def create_response(self, local_index: int) -> tuple[Response, TransportKeys]:
        if self.is_initiator:
            raise HandshakeError("only the responder creates a response")
        if self.remote_static_public is None:
            raise HandshakeError("consume_initiation must run first")
        self.local_index = local_index

        self.ephemeral_private, self.ephemeral_public = crypto.generate_keypair()
        (self.chaining_key,) = crypto.kdf(self.chaining_key, self.ephemeral_public, 1)
        self.hash = crypto.hash_(self.hash, self.ephemeral_public)

        # ee: binds both ephemerals, giving forward secrecy.
        (self.chaining_key,) = crypto.kdf(
            self.chaining_key, crypto.dh(self.ephemeral_private, self.remote_ephemeral), 1
        )
        # se: binds the initiator's static key.
        (self.chaining_key,) = crypto.kdf(
            self.chaining_key,
            crypto.dh(self.ephemeral_private, self.remote_static_public),
            1,
        )

        self.chaining_key, tau, key = crypto.kdf(self.chaining_key, self.preshared_key, 3)
        self.hash = crypto.hash_(self.hash, tau)
        enc_empty = crypto.aead_encrypt(key, 0, b"", self.hash)
        self.hash = crypto.hash_(self.hash, enc_empty)

        message = Response(
            sender=local_index,
            receiver=self.remote_index,
            ephemeral=self.ephemeral_public,
            enc_empty=enc_empty,
        )
        message = _with_mac1(message, mac1_key(self.remote_static_public))

        # The responder's send key is the initiator's receive key.
        recv_key, send_key = crypto.kdf(self.chaining_key, b"", 2)
        keys = TransportKeys(send_key=send_key, recv_key=recv_key)
        self._burn()
        return message, keys

    # -- housekeeping ----------------------------------------------------

    def _burn(self) -> None:
        """Drop handshake secrets once transport keys exist."""
        self.ephemeral_private = b""
        self.chaining_key = b""


def _with_mac1(message, key: bytes):
    """Return ``message`` with mac1 filled in."""
    return type(message)(
        **{**message.__dict__, "mac1": crypto.mac(key, message.mac1_input)}
    )


def verify_mac1(message, local_static_public: bytes) -> bool:
    """Constant-time check that a message carries our mac1 stamp."""
    expected = crypto.mac(mac1_key(local_static_public), message.mac1_input)
    return _constant_time_eq(expected, message.mac1)


def _constant_time_eq(a: bytes, b: bytes) -> bool:
    import hmac

    return hmac.compare_digest(a, b)
