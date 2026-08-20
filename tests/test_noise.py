"""Tests for the handshake."""

from __future__ import annotations

import unittest

import tests.support  # noqa: F401

from pyvpn import crypto, noise
from pyvpn.messages import Initiation, Response
from pyvpn.noise import HandshakeError, HandshakeState


class HandshakeTestCase(unittest.TestCase):
    def setUp(self):
        self.initiator_private, self.initiator_public = crypto.generate_keypair()
        self.responder_private, self.responder_public = crypto.generate_keypair()
        self.psk = crypto.random_bytes(32)

    def initiator(self, psk=None, remote=None):
        return HandshakeState(
            self.initiator_private,
            self.initiator_public,
            remote if remote is not None else self.responder_public,
            preshared_key=self.psk if psk is None else psk,
        )

    def responder(self, psk=None):
        return HandshakeState(
            self.responder_private,
            self.responder_public,
            preshared_key=self.psk if psk is None else psk,
        )

    def complete(self):
        initiator, responder = self.initiator(), self.responder()
        initiation = initiator.create_initiation(1)
        responder.consume_initiation(Initiation.from_bytes(initiation.to_bytes()))
        response, responder_keys = responder.create_response(2)
        initiator_keys = initiator.consume_response(Response.from_bytes(response.to_bytes()))
        return initiator_keys, responder_keys


class SuccessfulHandshake(HandshakeTestCase):
    def test_both_sides_agree_on_keys(self):
        initiator_keys, responder_keys = self.complete()
        self.assertEqual(initiator_keys.send_key, responder_keys.recv_key)
        self.assertEqual(initiator_keys.recv_key, responder_keys.send_key)

    def test_the_two_directions_use_different_keys(self):
        initiator_keys, _ = self.complete()
        self.assertNotEqual(initiator_keys.send_key, initiator_keys.recv_key)

    def test_each_handshake_produces_fresh_keys(self):
        first, _ = self.complete()
        second, _ = self.complete()
        self.assertNotEqual(first.send_key, second.send_key)

    def test_responder_learns_the_initiator_identity(self):
        initiator, responder = self.initiator(), self.responder()
        initiation = initiator.create_initiation(1)
        learned = responder.consume_initiation(initiation)
        self.assertEqual(learned, self.initiator_public)

    def test_the_static_key_is_not_sent_in_the_clear(self):
        """Identity hiding: an eavesdropper cannot see who is connecting."""
        initiation = self.initiator().create_initiation(1)
        self.assertNotIn(self.initiator_public, initiation.to_bytes())

    def test_ephemeral_secrets_are_discarded_once_keys_exist(self):
        """Forward secrecy depends on the ephemeral key not outliving the handshake."""
        initiator, responder = self.initiator(), self.responder()
        initiation = initiator.create_initiation(1)
        responder.consume_initiation(initiation)
        response, _ = responder.create_response(2)
        initiator.consume_response(response)
        self.assertEqual(initiator.ephemeral_private, b"")
        self.assertEqual(responder.ephemeral_private, b"")


class RejectedHandshake(HandshakeTestCase):
    def test_wrong_preshared_key_fails(self):
        initiator = self.initiator()
        responder = self.responder(psk=crypto.random_bytes(32))
        responder.consume_initiation(initiator.create_initiation(1))
        response, _ = responder.create_response(2)
        with self.assertRaises(HandshakeError):
            initiator.consume_response(response)

    def test_initiation_addressed_to_another_server_fails(self):
        _, someone_else = crypto.generate_keypair()
        initiator = self.initiator(remote=someone_else)
        with self.assertRaises(HandshakeError):
            self.responder().consume_initiation(initiator.create_initiation(1))

    def test_tampered_initiation_fails(self):
        initiation = self.initiator().create_initiation(1)
        raw = bytearray(initiation.to_bytes())
        raw[50] ^= 0x01  # inside the encrypted static key
        with self.assertRaises(HandshakeError):
            self.responder().consume_initiation(Initiation.from_bytes(bytes(raw)))

    def test_tampered_ephemeral_fails(self):
        initiation = self.initiator().create_initiation(1)
        raw = bytearray(initiation.to_bytes())
        raw[10] ^= 0xFF  # inside the ephemeral public key
        with self.assertRaises(HandshakeError):
            self.responder().consume_initiation(Initiation.from_bytes(bytes(raw)))

    def test_response_from_an_impostor_fails(self):
        initiator, responder = self.initiator(), self.responder()
        responder.consume_initiation(initiator.create_initiation(1))
        response, _ = responder.create_response(2)
        forged = Response(
            sender=response.sender,
            receiver=response.receiver,
            ephemeral=crypto.generate_keypair()[1],
            enc_empty=response.enc_empty,
            mac1=response.mac1,
        )
        with self.assertRaises(HandshakeError):
            initiator.consume_response(forged)

    def test_initiator_must_know_the_responder_key(self):
        state = HandshakeState(self.initiator_private, self.initiator_public)
        with self.assertRaises(HandshakeError):
            state.create_initiation(1)

    def test_a_responder_cannot_consume_a_response(self):
        responder = self.responder()
        responder.consume_initiation(self.initiator().create_initiation(1))
        response, _ = responder.create_response(2)
        with self.assertRaises(HandshakeError):
            responder.consume_response(response)


class MessageAuthenticationCode(HandshakeTestCase):
    def test_mac1_is_valid_for_the_intended_recipient(self):
        initiation = self.initiator().create_initiation(1)
        self.assertTrue(noise.verify_mac1(initiation, self.responder_public))

    def test_mac1_fails_for_anyone_else(self):
        _, other_public = crypto.generate_keypair()
        initiation = self.initiator().create_initiation(1)
        self.assertFalse(noise.verify_mac1(initiation, other_public))

    def test_mac1_covers_the_message_body(self):
        initiation = self.initiator().create_initiation(1)
        tampered = Initiation(
            sender=initiation.sender,
            ephemeral=initiation.ephemeral,
            enc_static=initiation.enc_static,
            enc_timestamp=b"\x00" * 28,
            mac1=initiation.mac1,
        )
        self.assertFalse(noise.verify_mac1(tampered, self.responder_public))

    def test_response_carries_a_mac1_for_the_initiator(self):
        initiator, responder = self.initiator(), self.responder()
        responder.consume_initiation(initiator.create_initiation(1))
        response, _ = responder.create_response(2)
        self.assertTrue(noise.verify_mac1(response, self.initiator_public))


class Timestamps(HandshakeTestCase):
    def test_initiations_carry_increasing_timestamps(self):
        """The responder relies on this to reject replayed initiations."""
        first = self.initiator()
        first.create_initiation(1)
        second = self.initiator()
        second.create_initiation(2)
        self.assertLess(first.timestamp, second.timestamp)

    def test_responder_recovers_the_timestamp(self):
        initiator, responder = self.initiator(), self.responder()
        responder.consume_initiation(initiator.create_initiation(1))
        self.assertEqual(responder.timestamp, initiator.timestamp)


if __name__ == "__main__":
    unittest.main()
