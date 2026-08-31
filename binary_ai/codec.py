"""Text <-> binary conversion.

The encoding is a real, lossless UTF-8 bit encoding: every byte of the UTF-8
representation of the text becomes exactly eight '0'/'1' characters.  Nothing
is abbreviated and nothing is dropped, so ``decode(encode(text)) == text`` for
any string, including CJK text and emoji.
"""

from __future__ import annotations

BITS_PER_BYTE = 8


class BinaryDecodeError(ValueError):
    """Raised when a string is not a valid binary-encoded message."""


def encode(text: str, separator: str = " ") -> str:
    """Encode ``text`` as a string of 0s and 1s.

    Each UTF-8 byte becomes an 8-bit group; groups are joined by ``separator``
    (use ``""`` for one unbroken bit string).

    >>> encode("Hi")
    '01001000 01101001'
    """
    return separator.join(format(byte, "08b") for byte in text.encode("utf-8"))


def decode(bits: str) -> str:
    """Decode a string of 0s and 1s back into text.

    Any whitespace between groups is ignored, so both ``"01001000 01101001"``
    and ``"0100100001101001"`` decode to ``"Hi"``.
    """
    stripped = "".join(bits.split())
    if not stripped:
        return ""
    if stripped.strip("01"):
        raise BinaryDecodeError("input contains characters other than 0 and 1")
    if len(stripped) % BITS_PER_BYTE:
        raise BinaryDecodeError(
            f"bit length {len(stripped)} is not a multiple of {BITS_PER_BYTE}"
        )
    payload = bytes(
        int(stripped[i : i + BITS_PER_BYTE], 2)
        for i in range(0, len(stripped), BITS_PER_BYTE)
    )
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError as exc:  # pragma: no cover - defensive
        raise BinaryDecodeError(f"bits are not valid UTF-8: {exc}") from exc


def looks_like_binary(text: str) -> bool:
    """Return True if ``text`` is a well-formed binary message."""
    stripped = "".join(text.split())
    return (
        bool(stripped)
        and not stripped.strip("01")
        and len(stripped) % BITS_PER_BYTE == 0
    )
