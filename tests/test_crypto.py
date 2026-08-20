"""Tests for the cryptographic primitives."""

from __future__ import annotations

import unittest

import tests.support  # noqa: F401 - puts the package on sys.path

from pyvpn import crypto


class KeyAgreement(unittest.TestCase):
    def test_both_sides_derive_the_same_secret(self):
        a_private, a_public = crypto.generate_keypair()
        b_private, b_public = crypto.generate_keypair()
        self.assertEqual(crypto.dh(a_private, b_public), crypto.dh(b_private, a_public))

    def test_public_key_can_be_recovered_from_the_private_key(self):
        private, public = crypto.generate_keypair()
        self.assertEqual(crypto.public_from_private(private), public)

    def test_distinct_keypairs_do_not_collide(self):
        keys = {crypto.generate_keypair()[1] for _ in range(64)}
        self.assertEqual(len(keys), 64)

    def test_low_order_public_key_is_refused(self):
        """An all-zero shared secret must never be accepted as a key."""
        private, _ = crypto.generate_keypair()
        with self.assertRaises(ValueError):
            crypto.dh(private, b"\x00" * 32)


class KeyDerivation(unittest.TestCase):
    def test_kdf_is_deterministic(self):
        key, data = b"\x01" * 32, b"chaining input"
        self.assertEqual(crypto.kdf(key, data, 3), crypto.kdf(key, data, 3))

    def test_kdf_outputs_are_independent(self):
        outputs = crypto.kdf(b"\x02" * 32, b"input", 3)
        self.assertEqual(len(outputs), 3)
        self.assertEqual(len(set(outputs)), 3)
        self.assertTrue(all(len(output) == 32 for output in outputs))

    def test_kdf_prefix_property(self):
        """Asking for more outputs extends the sequence rather than changing it."""
        two = crypto.kdf(b"\x03" * 32, b"x", 2)
        three = crypto.kdf(b"\x03" * 32, b"x", 3)
        self.assertEqual(three[:2], two)

    def test_changing_the_input_changes_every_output(self):
        first = crypto.kdf(b"\x04" * 32, b"a", 2)
        second = crypto.kdf(b"\x04" * 32, b"b", 2)
        self.assertTrue(all(x != y for x, y in zip(first, second)))

    def test_output_count_is_bounded(self):
        with self.assertRaises(ValueError):
            crypto.kdf(b"\x05" * 32, b"x", 0)


class AuthenticatedEncryption(unittest.TestCase):
    def setUp(self):
        self.key = crypto.random_bytes(32)

    def test_round_trip(self):
        sealed = crypto.aead_encrypt(self.key, 1, b"plaintext", b"header")
        self.assertEqual(crypto.aead_decrypt(self.key, 1, sealed, b"header"), b"plaintext")

    def test_ciphertext_is_expanded_by_the_tag_only(self):
        sealed = crypto.aead_encrypt(self.key, 1, b"x" * 100, b"")
        self.assertEqual(len(sealed), 100 + crypto.TAG_LEN)

    def test_modified_ciphertext_is_rejected(self):
        sealed = bytearray(crypto.aead_encrypt(self.key, 1, b"plaintext", b"header"))
        sealed[3] ^= 0x40
        with self.assertRaises(crypto.InvalidTag):
            crypto.aead_decrypt(self.key, 1, bytes(sealed), b"header")

    def test_modified_associated_data_is_rejected(self):
        sealed = crypto.aead_encrypt(self.key, 1, b"plaintext", b"header")
        with self.assertRaises(crypto.InvalidTag):
            crypto.aead_decrypt(self.key, 1, sealed, b"header!")

    def test_wrong_counter_is_rejected(self):
        sealed = crypto.aead_encrypt(self.key, 1, b"plaintext", b"header")
        with self.assertRaises(crypto.InvalidTag):
            crypto.aead_decrypt(self.key, 2, sealed, b"header")

    def test_wrong_key_is_rejected(self):
        sealed = crypto.aead_encrypt(self.key, 1, b"plaintext", b"header")
        with self.assertRaises(crypto.InvalidTag):
            crypto.aead_decrypt(crypto.random_bytes(32), 1, sealed, b"header")

    def test_the_same_plaintext_encrypts_differently_under_different_counters(self):
        first = crypto.aead_encrypt(self.key, 1, b"same", b"")
        second = crypto.aead_encrypt(self.key, 2, b"same", b"")
        self.assertNotEqual(first, second)

    def test_counter_must_fit_in_the_nonce(self):
        with self.assertRaises(ValueError):
            crypto.aead_encrypt(self.key, 1 << 64, b"x", b"")


class Timestamps(unittest.TestCase):
    def test_length_is_fixed(self):
        self.assertEqual(len(crypto.tai64n()), crypto.TIMESTAMP_LEN)

    def test_timestamps_increase_with_time(self):
        earlier = crypto.tai64n(1_000_000.0)
        later = crypto.tai64n(1_000_001.0)
        self.assertLess(earlier, later)
        self.assertLess(crypto.tai64n(1.0), crypto.tai64n(1.5))


class Mac(unittest.TestCase):
    def test_mac_depends_on_key_and_message(self):
        key = crypto.random_bytes(32)
        self.assertEqual(len(crypto.mac(key, b"message")), crypto.MAC_LEN)
        self.assertNotEqual(crypto.mac(key, b"message"), crypto.mac(key, b"message!"))
        self.assertNotEqual(
            crypto.mac(key, b"message"), crypto.mac(crypto.random_bytes(32), b"message")
        )


if __name__ == "__main__":
    unittest.main()
