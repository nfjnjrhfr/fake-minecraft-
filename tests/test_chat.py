import anthropic
import httpx2
import pytest

from binary_ai.chat import FALLBACK_BETA, SYSTEM_PROMPT, BinaryChat
from binary_ai.codec import decode, encode


class FakeStream:
    def __init__(self, chunks):
        self.text_stream = iter(chunks)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeMessages:
    """Records every call; optionally raises before the first success."""

    def __init__(self, chunks=("hi",), raises=None):
        self.chunks = chunks
        self.raises = raises
        self.calls = []

    def stream(self, **kwargs):
        self.calls.append(kwargs)
        if self.raises is not None:
            raise self.raises
        return FakeStream(self.chunks)


class FakeClient:
    def __init__(self, messages=None, beta_messages=None):
        self.messages = messages or FakeMessages()
        self.beta = type("Beta", (), {"messages": beta_messages or FakeMessages()})()


def _bad_request(message="beta not enabled"):
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return anthropic.BadRequestError(
        message, response=httpx2.Response(400, request=request), body=None
    )


def test_send_transmits_binary_not_plain_text():
    beta = FakeMessages(chunks=["hello ", "there"])
    chat = BinaryChat(client=FakeClient(beta_messages=beta))

    reply = "".join(chat.send("測試訊息"))

    assert reply == "hello there"
    sent = beta.calls[0]["messages"][-1]["content"]
    assert set(sent) <= {"0", "1", " "}
    assert "測試訊息" not in sent
    assert decode(sent) == "測試訊息"


def test_request_carries_system_prompt_and_fallbacks():
    beta = FakeMessages()
    chat = BinaryChat(client=FakeClient(beta_messages=beta), effort="low")

    list(chat.send("hi"))

    call = beta.calls[0]
    assert call["system"] == SYSTEM_PROMPT
    assert call["betas"] == [FALLBACK_BETA]
    assert call["fallbacks"] == "default"
    assert call["output_config"] == {"effort": "low"}
    assert call["model"] == "claude-opus-5"


def test_history_keeps_binary_for_user_and_text_for_assistant():
    beta = FakeMessages(chunks=["first reply"])
    chat = BinaryChat(client=FakeClient(beta_messages=beta))

    list(chat.send("one"))
    assert chat.history == [
        {"role": "user", "content": encode("one")},
        {"role": "assistant", "content": "first reply"},
    ]

    list(chat.send("two"))
    assert [m["role"] for m in chat.history] == [
        "user",
        "assistant",
        "user",
        "assistant",
    ]
    assert beta.calls[1]["messages"][0]["content"] == encode("one")
    assert beta.calls[1]["messages"][-1]["content"] == encode("two")


def test_history_unchanged_when_the_stream_fails():
    beta = FakeMessages(raises=_bad_request())
    plain = FakeMessages(raises=anthropic.APIConnectionError(request=None))
    chat = BinaryChat(client=FakeClient(messages=plain, beta_messages=beta))

    with pytest.raises(anthropic.APIConnectionError):
        list(chat.send("hi"))

    assert chat.history == []


def test_reset_clears_history():
    chat = BinaryChat(client=FakeClient())
    list(chat.send("hi"))
    chat.reset()
    assert chat.history == []


def test_falls_back_to_non_beta_endpoint_and_stays_there():
    beta = FakeMessages(raises=_bad_request())
    plain = FakeMessages(chunks=["ok"])
    chat = BinaryChat(client=FakeClient(messages=plain, beta_messages=beta))

    assert "".join(chat.send("hi")) == "ok"
    assert len(beta.calls) == 1
    assert "fallbacks" not in plain.calls[0]

    assert "".join(chat.send("again")) == "ok"
    assert len(beta.calls) == 1  # not retried
    assert len(plain.calls) == 2


def test_encode_message_matches_what_is_sent():
    beta = FakeMessages()
    chat = BinaryChat(client=FakeClient(beta_messages=beta))
    payload = chat.encode_message("hi")
    list(chat.send("hi"))
    assert beta.calls[0]["messages"][-1]["content"] == payload
