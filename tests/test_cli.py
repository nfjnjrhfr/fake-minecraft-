import pytest

from binary_ai import cli
from binary_ai.codec import encode


class FakeChat:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.sent = []
        self.resets = 0

    def encode_message(self, text):
        return encode(text)

    def reset(self):
        self.resets += 1

    def send(self, text):
        self.sent.append(text)
        yield f"echo:{text}"


@pytest.fixture
def fake_chat(monkeypatch):
    created = []

    def factory(**kwargs):
        chat = FakeChat(**kwargs)
        created.append(chat)
        return chat

    monkeypatch.setattr(cli, "BinaryChat", factory)
    return created


def _run(monkeypatch, inputs, argv=None):
    queue = iter(inputs)
    monkeypatch.setattr("builtins.input", lambda _prompt="": next(queue))
    return cli.main(argv or [])


def test_chat_prints_reply_but_never_the_bits(monkeypatch, capsys, fake_chat):
    assert _run(monkeypatch, ["你好", "/quit"]) == 0

    out = capsys.readouterr()
    assert "echo:你好" in out.out
    assert encode("你好") not in out.out + out.err
    assert fake_chat[0].sent == ["你好"]


def test_debug_flag_shows_the_bits_on_stderr(monkeypatch, capsys, fake_chat):
    assert _run(monkeypatch, ["hi", "/quit"], argv=["--debug"]) == 0

    out = capsys.readouterr()
    assert encode("hi") in out.err
    assert encode("hi") not in out.out


def test_slash_commands(monkeypatch, capsys, fake_chat):
    assert _run(monkeypatch, ["/help", "", "/reset", "/quit"]) == 0

    out = capsys.readouterr().out
    assert "/reset" in out
    assert fake_chat[0].resets == 1
    assert fake_chat[0].sent == []


def test_eof_exits_cleanly(monkeypatch, capsys, fake_chat):
    def raise_eof(_prompt=""):
        raise EOFError

    monkeypatch.setattr("builtins.input", raise_eof)
    assert cli.main([]) == 0


def test_cli_options_reach_the_chat_session(monkeypatch, fake_chat):
    _run(monkeypatch, ["/quit"], argv=["--model", "claude-sonnet-5", "--effort", "low", "--max-tokens", "1000"])

    assert fake_chat[0].kwargs == {
        "model": "claude-sonnet-5",
        "effort": "low",
        "max_tokens": 1000,
    }
