import pytest

from binary_ai.codec import BinaryDecodeError, decode, encode, looks_like_binary


def test_encode_known_value():
    assert encode("Hi") == "01001000 01101001"


def test_encode_without_separator():
    assert encode("Hi", separator="") == "0100100001101001"


@pytest.mark.parametrize(
    "text",
    ["hello world", "你好，世界", "こんにちは", "emoji 🙂🚀", "", "line1\nline2", "0101"],
)
def test_roundtrip(text):
    assert decode(encode(text)) == text


def test_multibyte_uses_one_group_per_utf8_byte():
    bits = encode("你")
    assert len(bits.split()) == 3  # 你 is three UTF-8 bytes
    assert all(len(group) == 8 for group in bits.split())


def test_decode_ignores_whitespace():
    assert decode(" 01001000\n01101001 ") == "Hi"


def test_decode_empty_is_empty():
    assert decode("   ") == ""


def test_decode_rejects_non_binary_characters():
    with pytest.raises(BinaryDecodeError):
        decode("0100100x")


def test_decode_rejects_partial_byte():
    with pytest.raises(BinaryDecodeError):
        decode("0100100")


def test_decode_rejects_invalid_utf8():
    with pytest.raises(BinaryDecodeError):
        decode("11111111")


def test_looks_like_binary():
    assert looks_like_binary("01001000 01101001")
    assert not looks_like_binary("hello")
    assert not looks_like_binary("0100100")
    assert not looks_like_binary("")
