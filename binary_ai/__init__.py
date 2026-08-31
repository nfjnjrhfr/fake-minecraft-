"""Chat with Claude, where your messages travel as 0s and 1s."""

from binary_ai.chat import BinaryChat
from binary_ai.codec import BinaryDecodeError, decode, encode, looks_like_binary

__all__ = [
    "BinaryChat",
    "BinaryDecodeError",
    "decode",
    "encode",
    "looks_like_binary",
]
