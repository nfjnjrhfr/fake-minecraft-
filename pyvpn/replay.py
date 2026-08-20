"""Sliding-window replay protection for transport counters.

Each transport key gets one window.  A counter is accepted once and only
once; anything older than the window, or already seen, is rejected.  This is
the standard IPsec/WireGuard anti-replay algorithm (RFC 6479) implemented
over a Python integer used as a bitmap.
"""

from __future__ import annotations

WINDOW_BITS = 2048
REJECT_AFTER_MESSAGES = (1 << 64) - (1 << 13) - 1


class ReplayWindow:
    """Accepts each counter at most once, tolerating reordering."""

    __slots__ = ("_greatest", "_bitmap", "_window")

    def __init__(self, window: int = WINDOW_BITS) -> None:
        if window < 1:
            raise ValueError("window must be positive")
        self._window = window
        self._greatest = -1
        self._bitmap = 0

    @property
    def greatest(self) -> int:
        return self._greatest

    def check(self, counter: int) -> bool:
        """Return whether ``counter`` is fresh, recording it if so."""
        if counter < 0 or counter >= REJECT_AFTER_MESSAGES:
            return False

        if counter > self._greatest:
            shift = counter - self._greatest
            if shift >= self._window:
                self._bitmap = 0
            else:
                self._bitmap = (self._bitmap << shift) & ((1 << self._window) - 1)
            self._bitmap |= 1
            self._greatest = counter
            return True

        offset = self._greatest - counter
        if offset >= self._window:
            return False  # too old to prove it is not a replay
        bit = 1 << offset
        if self._bitmap & bit:
            return False  # already seen
        self._bitmap |= bit
        return True
