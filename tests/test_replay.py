"""Tests for the anti-replay window."""

from __future__ import annotations

import unittest

import tests.support  # noqa: F401

from pyvpn.replay import REJECT_AFTER_MESSAGES, ReplayWindow, WINDOW_BITS


class Window(unittest.TestCase):
    def setUp(self):
        self.window = ReplayWindow()

    def test_a_fresh_counter_is_accepted_once(self):
        self.assertTrue(self.window.check(0))
        self.assertFalse(self.window.check(0))

    def test_increasing_counters_are_accepted(self):
        self.assertTrue(all(self.window.check(counter) for counter in range(1000)))

    def test_reordering_within_the_window_is_tolerated(self):
        self.assertTrue(self.window.check(100))
        for counter in (99, 50, 1):
            self.assertTrue(self.window.check(counter), counter)
        self.assertFalse(self.window.check(50))

    def test_counters_older_than_the_window_are_refused(self):
        self.assertTrue(self.window.check(WINDOW_BITS * 2))
        self.assertFalse(self.window.check(1))

    def test_a_large_jump_forward_resets_the_window(self):
        self.assertTrue(self.window.check(5))
        self.assertTrue(self.window.check(10**6))
        self.assertFalse(self.window.check(5))
        self.assertTrue(self.window.check(10**6 - 1))

    def test_the_edge_of_the_window_behaves(self):
        self.assertTrue(self.window.check(WINDOW_BITS))
        self.assertTrue(self.window.check(1), "the oldest in-window counter")
        self.assertFalse(self.window.check(0), "one past the window")

    def test_negative_and_oversized_counters_are_refused(self):
        self.assertFalse(self.window.check(-1))
        self.assertFalse(self.window.check(REJECT_AFTER_MESSAGES))

    def test_greatest_counter_is_tracked(self):
        for counter in (3, 9, 4):
            self.window.check(counter)
        self.assertEqual(self.window.greatest, 9)

    def test_replaying_an_entire_captured_run_is_refused(self):
        counters = list(range(500))
        for counter in counters:
            self.window.check(counter)
        self.assertFalse(any(self.window.check(counter) for counter in counters))

    def test_window_size_must_be_positive(self):
        with self.assertRaises(ValueError):
            ReplayWindow(0)


if __name__ == "__main__":
    unittest.main()
