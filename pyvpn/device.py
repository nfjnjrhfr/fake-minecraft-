"""The tunnel engine.

One event loop moves packets in both directions:

    tun --> encrypt --> UDP        (traffic leaving this host)
    UDP --> decrypt --> tun        (traffic arriving for this host)

The same engine runs on both ends.  A server and a client differ only in
which side knows the other's endpoint up front, and in the routing and NAT
that :mod:`pyvpn.server` and :mod:`pyvpn.client` set up around it.
"""

from __future__ import annotations

import ipaddress
import logging
import selectors
import socket
import time

from . import crypto, ip, messages, noise
from .config import Config, encode_key
from .messages import (
    DATA_OVERHEAD,
    MSG_COOKIE,
    MSG_DATA,
    MSG_INITIATION,
    MSG_RESPONSE,
    Initiation,
    MalformedPacket,
    Response,
)
from .noise import HandshakeError, HandshakeState
from .peer import Keypair, Peer, REKEY_TIMEOUT, random_index

log = logging.getLogger("pyvpn")

TICK_INTERVAL = 1.0
MAX_DATAGRAM = 65535
MAX_BURST = 256  # packets handled per readiness notification
HANDSHAKES_PER_SECOND = 20  # per source address, before we start dropping


class Device:
    """Runs the tunnel for one interface."""

    def __init__(self, config: Config, tun, sock: socket.socket) -> None:
        self.config = config
        self.tun = tun
        self.sock = sock
        self.private_key = config.interface.private_key
        self.public_key = crypto.public_from_private(self.private_key)

        self.peers: list[Peer] = [Peer(peer) for peer in config.peers]
        self._by_key = {peer.public_key: peer for peer in self.peers}
        self._by_index: dict[int, tuple[Peer, Keypair]] = {}
        self._handshake_index: dict[int, Peer] = {}
        self._routes = sorted(
            ((network, peer) for peer in self.peers for network in peer.allowed_ips),
            key=lambda item: item[0].prefixlen,
            reverse=True,
        )
        self._rate_limit: dict[str, tuple[float, int]] = {}
        self._running = False
        self.dropped_unroutable = 0
        self.dropped_unknown = 0

    # -- lifecycle -------------------------------------------------------

    def run(self) -> None:
        """Pump packets until :meth:`stop` is called."""
        self._running = True
        selector = selectors.DefaultSelector()
        selector.register(self.tun.fileno(), selectors.EVENT_READ, "tun")
        selector.register(self.sock.fileno(), selectors.EVENT_READ, "udp")
        next_tick = time.monotonic()
        try:
            while self._running:
                for key, _ in selector.select(timeout=TICK_INTERVAL):
                    if key.data == "tun":
                        self._drain_tun()
                    else:
                        self._drain_socket()
                now = time.monotonic()
                if now >= next_tick:
                    self.tick(now)
                    next_tick = now + TICK_INTERVAL
        finally:
            selector.close()

    def stop(self) -> None:
        self._running = False

    # -- outbound: tun -> network ----------------------------------------

    def _drain_tun(self) -> None:
        # Keep reading until the interface is empty; one packet per wakeup
        # would cap throughput at one select() round trip per packet.
        for _ in range(MAX_BURST):
            try:
                packet = self.tun.read(MAX_DATAGRAM)
            except (BlockingIOError, InterruptedError):
                return
            except OSError as exc:
                log.error("read from %s failed: %s", getattr(self.tun, "name", "tun"), exc)
                return
            if not packet:
                return
            self.handle_outbound(packet)

    def handle_outbound(self, packet: bytes) -> None:
        """Encrypt one IP packet from the tunnel interface and send it."""
        header = ip.parse_ipv4(packet)
        if header is None:
            # IPv6 and malformed frames have nowhere to go: AllowedIPs, and
            # therefore cryptokey routing, is IPv4-only here.
            self.dropped_unroutable += 1
            log.debug("dropping non-IPv4 packet of %d bytes", len(packet))
            return

        peer = self.route(header.destination)
        if peer is None:
            self.dropped_unroutable += 1
            log.debug("no peer owns %s, dropping", header.destination)
            return

        keypair = peer.sending_keypair()
        if keypair is None:
            peer.queue.append(packet)
            self._maybe_handshake(peer, time.monotonic())
            return
        self._send_data(peer, keypair, packet)

    def _send_data(self, peer: Peer, keypair: Keypair, payload: bytes) -> None:
        if peer.endpoint is None:
            return
        # Pad to a 16-byte boundary so packet lengths leak a little less about
        # the plaintext; the receiver trims using the IP header's length.
        padding = (-len(payload)) % 16
        counter = keypair.next_counter()
        header = messages.data_header(keypair.remote_index, counter)
        try:
            sealed = crypto.aead_encrypt(
                keypair.send_key, counter, payload + b"\x00" * padding, header
            )
        except Exception as exc:  # noqa: BLE001 - never let one packet kill the loop
            log.error("encryption failed for %r: %s", peer, exc)
            return

        try:
            self.sock.sendto(header + sealed, peer.endpoint)
        except OSError as exc:
            log.warning("send to %s failed: %s", peer.endpoint, exc)
            return
        peer.last_sent = time.monotonic()
        peer.stats.tx_packets += 1
        peer.stats.tx_bytes += len(payload)

    # -- inbound: network -> tun -----------------------------------------

    def _drain_socket(self) -> None:
        for _ in range(MAX_BURST):
            try:
                datagram, sender = self.sock.recvfrom(MAX_DATAGRAM)
            except (BlockingIOError, InterruptedError):
                return
            except OSError as exc:
                log.debug("recvfrom failed: %s", exc)
                return
            if not datagram:
                return
            try:
                self.handle_inbound(datagram, sender)
            except Exception as exc:  # noqa: BLE001 - a bad packet is not fatal
                log.debug("dropping packet from %s: %s", sender, exc)

    def handle_inbound(self, datagram: bytes, sender: tuple[str, int]) -> None:
        kind = messages.message_type(datagram)
        if kind == MSG_DATA:
            self._handle_data(datagram, sender)
        elif kind == MSG_INITIATION:
            self._handle_initiation(datagram, sender)
        elif kind == MSG_RESPONSE:
            self._handle_response(datagram, sender)
        elif kind == MSG_COOKIE:
            log.debug("cookie replies are not implemented; ignoring")
        else:
            raise MalformedPacket(f"unknown message type {kind}")

    def _handle_data(self, datagram: bytes, sender) -> None:
        receiver, counter = messages.parse_data_header(datagram)
        found = self._by_index.get(receiver)
        if found is None:
            self.dropped_unknown += 1
            log.debug("data for unknown session index %#x", receiver)
            return
        peer, keypair = found

        if keypair.expired():
            peer.stats.dropped_auth += 1
            return
        # Check the window before spending a decryption on the packet, then
        # again is unnecessary: the window entry is only claimed once here.
        if not keypair.replay.check(counter):
            peer.stats.dropped_replay += 1
            log.debug("replayed or stale counter %d from %r", counter, peer)
            return

        header = datagram[: messages.DATA_HEADER_LEN]
        try:
            plaintext = crypto.aead_decrypt(
                keypair.recv_key, counter, datagram[messages.DATA_HEADER_LEN :], header
            )
        except Exception:  # noqa: BLE001 - InvalidTag and friends
            peer.stats.dropped_auth += 1
            log.debug("authentication failed for data from %r", peer)
            return

        # The packet authenticated, so this really is our peer: adopt the
        # source address it came from, which is what lets a client roam
        # between networks without renegotiating.
        if peer.endpoint != sender:
            log.info("%r roamed to %s", peer, sender)
            peer.endpoint = sender
        peer.last_received = time.monotonic()
        peer.promote(keypair)

        if not plaintext:
            log.debug("keepalive from %r", peer)
            return

        packet = ip.trim(plaintext)
        header_info = ip.parse_ipv4(packet)
        if header_info is None:
            peer.stats.dropped_routing += 1
            return
        # Cryptokey routing: a peer may only send from addresses it owns,
        # which stops one client from spoofing another's traffic.
        if not peer.permits(header_info.source):
            peer.stats.dropped_routing += 1
            log.warning(
                "%r sent a packet from %s, which is outside its AllowedIPs",
                peer,
                header_info.source,
            )
            return

        peer.stats.rx_packets += 1
        peer.stats.rx_bytes += len(packet)
        try:
            self.tun.write(packet)
        except OSError as exc:
            log.warning("write to tunnel interface failed: %s", exc)

    # -- handshake -------------------------------------------------------

    def _handle_initiation(self, datagram: bytes, sender) -> None:
        message = Initiation.from_bytes(datagram)
        if not noise.verify_mac1(message, self.public_key):
            log.debug("initiation from %s has a bad mac1; ignoring", sender)
            return
        if not self._allow_handshake(sender):
            log.warning("rate limiting handshakes from %s", sender[0])
            return

        state = HandshakeState(self.private_key, self.public_key)
        try:
            remote_static = state.consume_initiation(message)
        except HandshakeError as exc:
            log.warning("rejecting initiation from %s: %s", sender, exc)
            return

        peer = self._by_key.get(remote_static)
        if peer is None:
            log.warning(
                "initiation from unknown public key %s at %s",
                encode_key(remote_static),
                sender,
            )
            return
        # Reject replayed initiations: timestamps must strictly increase.
        if peer.last_handshake_timestamp and state.timestamp <= peer.last_handshake_timestamp:
            log.warning("replayed handshake initiation from %r", peer)
            return
        peer.last_handshake_timestamp = state.timestamp
        state.preshared_key = peer.preshared_key

        local_index = self._allocate_index()
        try:
            response, keys = state.create_response(local_index)
        except HandshakeError as exc:
            log.warning("could not answer %r: %s", peer, exc)
            return

        peer.endpoint = sender
        keypair = Keypair(
            send_key=keys.send_key,
            recv_key=keys.recv_key,
            local_index=local_index,
            remote_index=message.sender,
            is_initiator=False,
        )
        self._register(peer, keypair)
        peer.install(keypair, as_current=False)
        peer.last_received = time.monotonic()

        try:
            self.sock.sendto(response.to_bytes(), sender)
            peer.last_sent = time.monotonic()
        except OSError as exc:
            log.warning("could not send handshake response to %s: %s", sender, exc)
            return
        log.info("completed handshake with %r (responder)", peer)

    def _handle_response(self, datagram: bytes, sender) -> None:
        message = Response.from_bytes(datagram)
        peer = self._handshake_index.get(message.receiver)
        if peer is None or peer.handshake is None:
            log.debug("response for an unknown handshake index from %s", sender)
            return
        if not noise.verify_mac1(message, self.public_key):
            log.debug("handshake response from %s has a bad mac1", sender)
            return

        try:
            keys = peer.handshake.consume_response(message)
        except HandshakeError as exc:
            log.warning("handshake response from %s failed: %s", sender, exc)
            return

        keypair = Keypair(
            send_key=keys.send_key,
            recv_key=keys.recv_key,
            local_index=peer.handshake_index,
            remote_index=message.sender,
            is_initiator=True,
        )
        self._handshake_index.pop(peer.handshake_index, None)
        peer.handshake = None
        self._register(peer, keypair)
        peer.install(keypair, as_current=True)
        peer.endpoint = sender
        peer.last_received = time.monotonic()
        log.info("completed handshake with %r (initiator)", peer)
        self._flush_queue(peer, keypair)

    def _flush_queue(self, peer: Peer, keypair: Keypair) -> None:
        while peer.queue:
            self._send_data(peer, keypair, peer.queue.popleft())

    def _maybe_handshake(self, peer: Peer, now: float) -> None:
        if peer.handshake is not None and now - peer.handshake_last_sent < REKEY_TIMEOUT:
            return
        self.start_handshake(peer, now)

    def start_handshake(self, peer: Peer, now: float | None = None) -> None:
        """Send (or re-send) a handshake initiation to ``peer``."""
        now = time.monotonic() if now is None else now
        if peer.endpoint is None:
            log.debug("cannot start a handshake with %r: no endpoint known", peer)
            return

        if peer.handshake is None:
            state = HandshakeState(
                self.private_key,
                self.public_key,
                remote_static_public=peer.public_key,
                preshared_key=peer.preshared_key,
            )
            index = self._allocate_index()
            try:
                message = state.create_initiation(index)
            except HandshakeError as exc:
                log.error("could not build an initiation for %r: %s", peer, exc)
                return
            peer.handshake = state
            peer.handshake_index = index
            peer.handshake_message = message.to_bytes()
            peer.handshake_started_at = now
            self._handshake_index[index] = peer

        try:
            self.sock.sendto(peer.handshake_message, peer.endpoint)
        except OSError as exc:
            log.warning("could not send handshake to %s: %s", peer.endpoint, exc)
            return
        peer.handshake_last_sent = now
        peer.last_sent = now
        log.info("sent handshake initiation to %r", peer)

    # -- timers ----------------------------------------------------------

    def tick(self, now: float | None = None) -> None:
        """Run periodic maintenance: rekeying, keepalives, key expiry."""
        now = time.monotonic() if now is None else now
        for peer in self.peers:
            for keypair in list(peer.keypairs()):
                if keypair.expired(now):
                    self._unregister(keypair)
            peer.expire_old_keys(now)

            if peer.handshake_gave_up(now):
                log.info("giving up on the handshake in flight with %r", peer)
                self._handshake_index.pop(peer.handshake_index, None)
                peer.handshake = None

            if peer.should_initiate(now):
                self.start_handshake(peer, now)
            elif peer.needs_keepalive(now):
                keypair = peer.sending_keypair()
                if keypair is not None:
                    self._send_data(peer, keypair, b"")

    # -- indices ---------------------------------------------------------

    def _allocate_index(self) -> int:
        while True:
            index = random_index()
            if index not in self._by_index and index not in self._handshake_index:
                return index

    def _register(self, peer: Peer, keypair: Keypair) -> None:
        self._by_index[keypair.local_index] = (peer, keypair)

    def _unregister(self, keypair: Keypair) -> None:
        self._by_index.pop(keypair.local_index, None)

    def _allow_handshake(self, sender) -> bool:
        """A crude token bucket, so an unauthenticated flood cannot pin a CPU."""
        now = time.monotonic()
        address = sender[0]
        window_start, count = self._rate_limit.get(address, (now, 0))
        if now - window_start >= 1.0:
            window_start, count = now, 0
        count += 1
        self._rate_limit[address] = (window_start, count)
        if len(self._rate_limit) > 4096:
            self._rate_limit = {
                key: value
                for key, value in self._rate_limit.items()
                if now - value[0] < 1.0
            }
        return count <= HANDSHAKES_PER_SECOND

    # -- routing ---------------------------------------------------------

    def route(self, destination: ipaddress.IPv4Address) -> Peer | None:
        """Longest-prefix match of ``destination`` against every AllowedIPs."""
        for network, peer in self._routes:
            if destination in network:
                return peer
        return None

    # -- introspection ---------------------------------------------------

    def status(self) -> str:
        lines = [f"interface: {getattr(self.tun, 'name', 'tun')}"]
        lines.append(f"  public key: {encode_key(self.public_key)}")
        lines.append(f"  listening port: {self.config.interface.listen_port}")
        for peer in self.peers:
            stats = peer.stats
            lines.append("")
            lines.append(f"peer: {encode_key(peer.public_key)}")
            lines.append(f"  endpoint: {peer.endpoint or 'unknown'}")
            lines.append(
                "  allowed ips: " + ", ".join(str(net) for net in peer.allowed_ips)
            )
            if peer.last_handshake_completed:
                age = time.monotonic() - peer.last_handshake_completed
                lines.append(f"  latest handshake: {age:.0f} seconds ago")
            else:
                lines.append("  latest handshake: never")
            lines.append(
                f"  transfer: {stats.rx_bytes} B received, {stats.tx_bytes} B sent"
            )
            if stats.dropped_replay or stats.dropped_auth or stats.dropped_routing:
                lines.append(
                    f"  dropped: {stats.dropped_auth} unauthenticated, "
                    f"{stats.dropped_replay} replayed, "
                    f"{stats.dropped_routing} outside AllowedIPs"
                )
            if peer.persistent_keepalive:
                lines.append(
                    f"  persistent keepalive: every {peer.persistent_keepalive} seconds"
                )
        return "\n".join(lines)


def tunnel_mtu(outer_mtu: int = 1500) -> int:
    """The largest tunnel MTU that still fits inside ``outer_mtu``.

    Overhead is 20 bytes of outer IPv4 header, 8 of UDP, and the data
    message's own header plus authentication tag.
    """
    return outer_mtu - 20 - 8 - DATA_OVERHEAD
