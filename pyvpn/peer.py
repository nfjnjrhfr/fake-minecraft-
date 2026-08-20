"""Per-peer session state: keys, timers and the endpoint we send to."""

from __future__ import annotations

import ipaddress
import os
import time
from collections import deque
from dataclasses import dataclass, field

from . import crypto
from .config import PeerConfig
from .replay import REJECT_AFTER_MESSAGES, ReplayWindow

# Timer constants, in seconds, following WireGuard's analysis of what keeps a
# session fresh without chattiness.
REKEY_AFTER_TIME = 120
REJECT_AFTER_TIME = 180
REKEY_TIMEOUT = 5
REKEY_ATTEMPT_TIME = 90
KEEPALIVE_TIMEOUT = 10
REKEY_AFTER_MESSAGES = 1 << 60

# Packets held while a handshake completes, so the first connection attempt
# through a cold tunnel does not simply vanish.
MAX_QUEUED_PACKETS = 128


@dataclass
class Keypair:
    """One direction pair of transport keys with its own replay window."""

    send_key: bytes
    recv_key: bytes
    local_index: int
    remote_index: int
    is_initiator: bool
    created_at: float = field(default_factory=time.monotonic)
    send_counter: int = 0
    replay: ReplayWindow = field(default_factory=ReplayWindow)

    def next_counter(self) -> int:
        counter = self.send_counter
        self.send_counter += 1
        return counter

    def expired(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        return (
            now - self.created_at >= REJECT_AFTER_TIME
            or self.send_counter >= REJECT_AFTER_MESSAGES
        )

    def needs_rekey(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        return (
            now - self.created_at >= REKEY_AFTER_TIME
            or self.send_counter >= REKEY_AFTER_MESSAGES
        )


@dataclass
class PeerStats:
    tx_bytes: int = 0
    rx_bytes: int = 0
    tx_packets: int = 0
    rx_packets: int = 0
    handshakes: int = 0
    dropped_replay: int = 0
    dropped_auth: int = 0
    dropped_routing: int = 0


class Peer:
    """Everything the device knows about one remote participant."""

    def __init__(self, config: PeerConfig) -> None:
        self.config = config
        self.public_key = config.public_key
        self.preshared_key = config.preshared_key or crypto.ZERO_KEY
        self.allowed_ips = list(config.allowed_ips)
        self.endpoint = config.endpoint
        self.persistent_keepalive = config.persistent_keepalive

        self.current: Keypair | None = None
        self.next: Keypair | None = None
        self.previous: Keypair | None = None

        self.handshake = None  # HandshakeState while one is in flight
        self.handshake_index = 0
        self.handshake_started_at = 0.0
        self.handshake_last_sent = 0.0
        self.handshake_message = b""
        self.last_handshake_timestamp = b""
        self.last_handshake_completed = 0.0

        self.last_sent = 0.0
        self.last_received = 0.0
        self.queue: deque[bytes] = deque(maxlen=MAX_QUEUED_PACKETS)
        self.stats = PeerStats()

    # -- keypair bookkeeping ---------------------------------------------

    def keypairs(self) -> list[Keypair]:
        return [kp for kp in (self.current, self.next, self.previous) if kp is not None]

    def install(self, keypair: Keypair, *, as_current: bool) -> None:
        """Adopt a freshly negotiated keypair.

        The initiator may send on it immediately.  The responder parks it as
        ``next`` and only promotes it once the peer actually uses it, so we
        never send under keys the initiator has not finished deriving.
        """
        if as_current:
            self.previous = self.current
            self.current = keypair
            self.next = None
        else:
            self.next = keypair
        self.stats.handshakes += 1
        self.last_handshake_completed = time.monotonic()

    def promote(self, keypair: Keypair) -> None:
        if self.next is keypair:
            self.previous = self.current
            self.current = keypair
            self.next = None

    def sending_keypair(self) -> Keypair | None:
        if self.current is not None and not self.current.expired():
            return self.current
        return None

    def expire_old_keys(self, now: float) -> None:
        for name in ("current", "next", "previous"):
            keypair = getattr(self, name)
            if keypair is not None and keypair.expired(now):
                setattr(self, name, None)

    def clear_keys(self) -> None:
        self.current = self.next = self.previous = None

    # -- handshake timing ------------------------------------------------

    def handshake_gave_up(self, now: float) -> bool:
        """Whether the in-flight handshake has been retried for long enough."""
        return (
            self.handshake is not None
            and now - self.handshake_started_at > REKEY_ATTEMPT_TIME
        )

    def should_initiate(self, now: float) -> bool:
        """Whether it is time to start (or retry) a handshake."""
        if self.handshake is not None:
            return now - self.handshake_last_sent >= REKEY_TIMEOUT
        if self.current is None:
            # Nothing to protect and nothing waiting: stay quiet.
            return bool(self.queue) or self.persistent_keepalive > 0
        return self.current.needs_rekey(now)

    def needs_keepalive(self, now: float) -> bool:
        if self.persistent_keepalive and now - self.last_sent >= self.persistent_keepalive:
            return True
        # Passive keepalive: tell a peer we are still here after it spoke to us.
        return (
            self.last_received > self.last_sent
            and now - self.last_received >= KEEPALIVE_TIMEOUT
        )

    # -- cryptokey routing -----------------------------------------------

    def permits(self, address: ipaddress.IPv4Address) -> bool:
        """Whether this peer is allowed to claim ``address`` as a source."""
        return any(address in network for network in self.allowed_ips)

    def __repr__(self) -> str:
        from .config import encode_key

        return f"<Peer {encode_key(self.public_key)[:12]}... endpoint={self.endpoint}>"


def random_index() -> int:
    return int.from_bytes(os.urandom(4), "little")
