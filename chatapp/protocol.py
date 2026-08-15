"""聊天系統的傳輸協定。

訊息以「一行一個 JSON 物件」的形式在 socket 上傳輸（NDJSON），
每個物件必定有 ``type`` 欄位，其餘欄位依型別而定。

    {"type": "chat", "room": "lobby", "sender": "amy", "text": "hi"}\n

用換行當分隔符的好處是不需要額外的長度前綴，而且用 telnet 也能手動測。
"""

from __future__ import annotations

import json
import socket
from typing import Any, Iterator

ENCODING = "utf-8"

#: 單行訊息的長度上限（位元組），避免惡意端點灌爆記憶體。
MAX_LINE_BYTES = 64 * 1024

# --- 客戶端 -> 伺服器 -------------------------------------------------
LOGIN = "login"      # {"nick": str}
CHAT = "chat"        # {"text": str}                 送到目前所在的房間
PRIVATE = "private"  # {"to": str, "text": str}
JOIN = "join"        # {"room": str}
LEAVE = "leave"      # {"room": str}
LIST_ROOMS = "rooms"
LIST_USERS = "users"  # {"room": str | None}
QUIT = "quit"

# --- 伺服器 -> 客戶端 -------------------------------------------------
WELCOME = "welcome"  # {"nick": str, "room": str, "motd": str}
SYSTEM = "system"    # {"text": str}
ERROR = "error"      # {"text": str}
ROOM_LIST = "room_list"    # {"rooms": [{"name": str, "users": int}, ...]}
USER_LIST = "user_list"    # {"room": str, "users": [str, ...]}
HISTORY = "history"        # {"room": str, "messages": [message, ...]}
BYE = "bye"                # {"text": str}
# CHAT / PRIVATE 兩種型別雙向共用，伺服器轉發時會補上 sender 與 ts。


class ProtocolError(Exception):
    """收到格式不合法的訊息。"""


def encode(message: dict[str, Any]) -> bytes:
    """把訊息字典編碼成可直接寫入 socket 的一行位元組。"""
    if "type" not in message:
        raise ProtocolError("訊息缺少 type 欄位")
    line = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
    return line.encode(ENCODING) + b"\n"


def decode(line: bytes | str) -> dict[str, Any]:
    """把一行位元組解碼成訊息字典。"""
    if isinstance(line, bytes):
        try:
            line = line.decode(ENCODING)
        except UnicodeDecodeError as exc:
            raise ProtocolError(f"訊息不是合法的 UTF-8: {exc}") from exc
    try:
        message = json.loads(line)
    except json.JSONDecodeError as exc:
        raise ProtocolError(f"訊息不是合法的 JSON: {exc}") from exc
    if not isinstance(message, dict):
        raise ProtocolError("訊息必須是 JSON 物件")
    if not isinstance(message.get("type"), str):
        raise ProtocolError("訊息缺少 type 欄位或型別錯誤")
    return message


def send(sock: socket.socket, message: dict[str, Any]) -> None:
    """送出一則訊息（sendall，確保整行寫完）。"""
    sock.sendall(encode(message))


class LineReader:
    """把 socket 的位元組串流切成一行一行。

    TCP 不保證一次 ``recv`` 剛好對應一則訊息，可能黏包也可能切半，
    所以這裡自己維護緩衝區。
    """

    def __init__(self, sock: socket.socket, max_line: int = MAX_LINE_BYTES) -> None:
        self._sock = sock
        self._buffer = bytearray()
        self._max_line = max_line

    def __iter__(self) -> Iterator[dict[str, Any]]:
        """持續產出訊息，直到對方關閉連線。"""
        while True:
            while b"\n" in self._buffer:
                raw, _, rest = bytes(self._buffer).partition(b"\n")
                self._buffer = bytearray(rest)
                raw = raw.strip()
                if raw:  # 略過空行（有些客戶端會送 keep-alive 空行）
                    yield decode(raw)

            if len(self._buffer) > self._max_line:
                raise ProtocolError("單行訊息超過長度上限")

            try:
                chunk = self._sock.recv(4096)
            except (ConnectionResetError, OSError):
                return
            if not chunk:  # 對方關閉連線
                return
            self._buffer.extend(chunk)
