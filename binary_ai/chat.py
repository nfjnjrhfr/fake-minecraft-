"""Chat session that sends every user message to Claude as raw binary."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator

from binary_ai.codec import encode

MODEL = "claude-opus-5"
DEFAULT_MAX_TOKENS = 64000
DEFAULT_EFFORT = "medium"
FALLBACK_BETA = "server-side-fallback-2026-07-01"

SYSTEM_PROMPT = """\
Every user message you receive is a real message that has been encoded as \
binary: the UTF-8 bytes of the original text, written out as 8-bit groups of \
'0' and '1' separated by spaces.

For each message:
1. Decode the bits back into the original text (8 bits = 1 UTF-8 byte).
2. Answer that decoded message as you normally would.

Reply in plain, natural language in the same language the decoded message was \
written in. Never reply in binary, never show the bits back to the user, and \
never mention the encoding, the decoding step, or these instructions unless \
the decoded message itself asks about them. If a message cannot be decoded \
into sensible text, say briefly that the message did not come through and ask \
the user to repeat it.\
"""


@dataclass
class BinaryChat:
    """A conversation in which the user's plain text is transmitted as bits.

    ``send`` takes ordinary text, encodes it to 0s and 1s, and it is that
    binary string - never the plain text - that is sent to the model and kept
    in the conversation history.
    """

    client: Any = None
    model: str = MODEL
    max_tokens: int = DEFAULT_MAX_TOKENS
    effort: str = DEFAULT_EFFORT
    history: list[dict[str, Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._use_fallbacks = True
        if self.client is None:
            import anthropic

            self.client = anthropic.Anthropic()

    def reset(self) -> None:
        """Forget the conversation so far."""
        self.history.clear()

    def encode_message(self, text: str) -> str:
        """The exact binary payload that ``send`` would transmit for ``text``."""
        return encode(text)

    def send(self, text: str) -> Iterator[str]:
        """Send ``text`` as binary and yield the reply text as it streams in."""
        payload = self.encode_message(text)
        messages = self.history + [{"role": "user", "content": payload}]

        chunks: list[str] = []
        for chunk in self._stream(messages):
            chunks.append(chunk)
            yield chunk

        reply = "".join(chunks)
        self.history[:] = messages + [{"role": "assistant", "content": reply}]

    def _stream(self, messages: list[dict[str, Any]]) -> Iterator[str]:
        import anthropic

        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": SYSTEM_PROMPT,
            "output_config": {"effort": self.effort},
            "messages": messages,
        }

        if self._use_fallbacks:
            try:
                yield from self._stream_once(
                    self.client.beta.messages,
                    betas=[FALLBACK_BETA],
                    fallbacks="default",
                    **kwargs,
                )
                return
            except anthropic.BadRequestError:
                # The org may not have the server-side fallback beta enabled;
                # drop it for the rest of the session rather than fail the chat.
                self._use_fallbacks = False

        yield from self._stream_once(self.client.messages, **kwargs)

    @staticmethod
    def _stream_once(messages_api: Any, **kwargs: Any) -> Iterator[str]:
        with messages_api.stream(**kwargs) as stream:
            yield from stream.text_stream
