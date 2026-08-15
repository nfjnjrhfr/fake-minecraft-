"""多人聊天伺服器：一條連線一個執行緒。

用法::

    python -m chatapp server --host 0.0.0.0 --port 5000

設計重點：
* 所有共享狀態（暱稱表、房間表）都由 ``self._lock`` 保護。
* 每個連線各有一個寫入鎖，避免兩個執行緒同時 sendall 造成訊息交錯。
* 房間保留最近 N 則訊息，新加入的人會先收到歷史紀錄。
"""

from __future__ import annotations

import argparse
import logging
import re
import socket
import threading
import time
from collections import deque
from typing import Any, Iterable

from . import protocol
from .protocol import LineReader, ProtocolError

log = logging.getLogger("chatapp.server")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5000
DEFAULT_ROOM = "lobby"
HISTORY_SIZE = 50
MAX_TEXT_LEN = 2000

NICK_RE = re.compile(r"^[\w一-鿿.-]{1,20}$")
ROOM_RE = re.compile(r"^[\w一-鿿.-]{1,32}$")


def _now() -> float:
    return time.time()


class Client:
    """伺服器端對單一連線的檢視。"""

    def __init__(self, sock: socket.socket, addr: tuple[str, int]) -> None:
        self.sock = sock
        self.addr = addr
        self.nick: str | None = None
        self.rooms: set[str] = set()
        self.current_room: str | None = None
        self._write_lock = threading.Lock()
        self._closed = False

    @property
    def name(self) -> str:
        return self.nick or f"{self.addr[0]}:{self.addr[1]}"

    def send(self, message: dict[str, Any]) -> bool:
        """送出訊息；連線已斷則回傳 False（不拋例外，方便廣播時略過）。"""
        if self._closed:
            return False
        try:
            with self._write_lock:
                self.sock.sendall(protocol.encode(message))
            return True
        except OSError:
            self._closed = True
            return False

    def system(self, text: str) -> None:
        self.send({"type": protocol.SYSTEM, "text": text, "ts": _now()})

    def error(self, text: str) -> None:
        self.send({"type": protocol.ERROR, "text": text, "ts": _now()})

    def close(self) -> None:
        self._closed = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


class Room:
    def __init__(self, name: str) -> None:
        self.name = name
        self.members: set[Client] = set()
        self.history: deque[dict[str, Any]] = deque(maxlen=HISTORY_SIZE)


class ChatServer:
    def __init__(self, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT,
                 motd: str = "歡迎來到聊天室！輸入 /help 看指令。") -> None:
        self.host = host
        self.port = port
        self.motd = motd
        self._lock = threading.RLock()
        self._clients: set[Client] = set()
        self._nicks: dict[str, Client] = {}   # 小寫暱稱 -> client
        self._rooms: dict[str, Room] = {}
        self._server_sock: socket.socket | None = None
        self._running = threading.Event()
        self._threads: list[threading.Thread] = []

    # ------------------------------------------------------------------
    # 生命週期
    # ------------------------------------------------------------------
    @property
    def address(self) -> tuple[str, int]:
        """實際綁定的位址（port 傳 0 時可用來查真正的埠號）。"""
        if self._server_sock is None:
            raise RuntimeError("伺服器尚未啟動")
        return self._server_sock.getsockname()

    def start(self) -> tuple[str, int]:
        """綁定並開始監聽，但不阻塞（accept 迴圈跑在背景執行緒）。"""
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((self.host, self.port))
        sock.listen(64)
        self._server_sock = sock
        self._running.set()
        thread = threading.Thread(target=self._accept_loop, name="accept", daemon=True)
        thread.start()
        self._threads.append(thread)
        log.info("聊天伺服器啟動於 %s:%s", *self.address)
        return self.address

    def serve_forever(self) -> None:
        """啟動並阻塞，直到 Ctrl-C。"""
        self.start()
        try:
            while self._running.is_set():
                time.sleep(0.5)
        except KeyboardInterrupt:
            log.info("收到中斷訊號，準備關閉…")
        finally:
            self.stop()

    def stop(self) -> None:
        if not self._running.is_set():
            return
        self._running.clear()
        with self._lock:
            clients = list(self._clients)
        for client in clients:
            client.send({"type": protocol.BYE, "text": "伺服器關閉中"})
            client.close()
        if self._server_sock is not None:
            try:
                self._server_sock.close()
            except OSError:
                pass
            self._server_sock = None
        log.info("伺服器已關閉")

    def _accept_loop(self) -> None:
        assert self._server_sock is not None
        while self._running.is_set():
            try:
                conn, addr = self._server_sock.accept()
            except OSError:
                break  # socket 被 stop() 關掉了
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            client = Client(conn, addr)
            thread = threading.Thread(
                target=self._handle_client, args=(client,),
                name=f"client-{addr[0]}:{addr[1]}", daemon=True,
            )
            thread.start()
            self._threads.append(thread)

    # ------------------------------------------------------------------
    # 單一連線
    # ------------------------------------------------------------------
    def _handle_client(self, client: Client) -> None:
        log.info("新連線 %s", client.name)
        with self._lock:
            self._clients.add(client)
        try:
            for message in LineReader(client.sock):
                try:
                    if not self._dispatch(client, message):
                        break
                except ProtocolError as exc:
                    client.error(str(exc))
        except ProtocolError as exc:
            client.error(f"協定錯誤：{exc}")
        except OSError:
            pass
        finally:
            self._disconnect(client)

    def _disconnect(self, client: Client) -> None:
        with self._lock:
            self._clients.discard(client)
            if client.nick and self._nicks.get(client.nick.lower()) is client:
                del self._nicks[client.nick.lower()]
            rooms = list(client.rooms)
            for room_name in rooms:
                room = self._rooms.get(room_name)
                if room is not None:
                    room.members.discard(client)
            client.rooms.clear()
        for room_name in rooms:
            self._broadcast(room_name, {
                "type": protocol.SYSTEM,
                "room": room_name,
                "text": f"{client.name} 離開了聊天室",
                "ts": _now(),
            })
        self._prune_empty_rooms()
        client.close()
        log.info("連線結束 %s", client.name)

    def _dispatch(self, client: Client, message: dict[str, Any]) -> bool:
        """處理一則訊息；回傳 False 代表要結束這條連線。"""
        mtype = message["type"]

        if mtype == protocol.QUIT:
            client.send({"type": protocol.BYE, "text": "再見！"})
            return False

        if mtype == protocol.LOGIN:
            self._handle_login(client, message)
            return True

        if client.nick is None:
            client.error("請先登入（送出 login 訊息）")
            return True

        handlers = {
            protocol.CHAT: self._handle_chat,
            protocol.PRIVATE: self._handle_private,
            protocol.JOIN: self._handle_join,
            protocol.LEAVE: self._handle_leave,
            protocol.LIST_ROOMS: self._handle_list_rooms,
            protocol.LIST_USERS: self._handle_list_users,
        }
        handler = handlers.get(mtype)
        if handler is None:
            client.error(f"不支援的訊息型別：{mtype}")
            return True
        handler(client, message)
        return True

    # ------------------------------------------------------------------
    # 各種指令
    # ------------------------------------------------------------------
    def _handle_login(self, client: Client, message: dict[str, Any]) -> None:
        nick = str(message.get("nick", "")).strip()
        if not NICK_RE.match(nick):
            client.error("暱稱不合法：限 1-20 個字，只能用中英文、數字、_ . -")
            return
        with self._lock:
            if client.nick is not None:
                client.error("你已經登入了")
                return
            if nick.lower() in self._nicks:
                client.error(f"暱稱「{nick}」已經有人在用了")
                return
            client.nick = nick
            self._nicks[nick.lower()] = client
        client.send({
            "type": protocol.WELCOME,
            "nick": nick,
            "room": DEFAULT_ROOM,
            "motd": self.motd,
            "ts": _now(),
        })
        self._join_room(client, DEFAULT_ROOM)

    def _handle_chat(self, client: Client, message: dict[str, Any]) -> None:
        text = self._clean_text(client, message.get("text"))
        if text is None:
            return
        room_name = str(message.get("room") or client.current_room or "")
        if room_name not in client.rooms:
            client.error(f"你不在房間「{room_name}」裡")
            return
        payload = {
            "type": protocol.CHAT,
            "room": room_name,
            "sender": client.nick,
            "text": text,
            "ts": _now(),
        }
        with self._lock:
            room = self._rooms.get(room_name)
            if room is not None:
                room.history.append(payload)
        self._broadcast(room_name, payload)

    def _handle_private(self, client: Client, message: dict[str, Any]) -> None:
        text = self._clean_text(client, message.get("text"))
        if text is None:
            return
        target_nick = str(message.get("to", "")).strip()
        with self._lock:
            target = self._nicks.get(target_nick.lower())
        if target is None:
            client.error(f"找不到使用者「{target_nick}」")
            return
        payload = {
            "type": protocol.PRIVATE,
            "sender": client.nick,
            "to": target.nick,
            "text": text,
            "ts": _now(),
        }
        target.send(payload)
        if target is not client:
            client.send(payload)  # 回聲，讓寄件者看得到自己送出的私訊

    def _handle_join(self, client: Client, message: dict[str, Any]) -> None:
        room_name = str(message.get("room", "")).strip()
        if not ROOM_RE.match(room_name):
            client.error("房間名稱不合法：限 1-32 個字，只能用中英文、數字、_ . -")
            return
        if room_name in client.rooms:
            client.current_room = room_name
            client.system(f"你已經在「{room_name}」了，切換為目前房間")
            return
        self._join_room(client, room_name)

    def _join_room(self, client: Client, room_name: str) -> None:
        with self._lock:
            room = self._rooms.setdefault(room_name, Room(room_name))
            room.members.add(client)
            client.rooms.add(room_name)
            client.current_room = room_name
            history = list(room.history)
            members = sorted(c.name for c in room.members)
        if history:
            client.send({"type": protocol.HISTORY, "room": room_name,
                         "messages": history, "ts": _now()})
        client.send({"type": protocol.USER_LIST, "room": room_name,
                     "users": members, "ts": _now()})
        self._broadcast(room_name, {
            "type": protocol.SYSTEM,
            "room": room_name,
            "text": f"{client.name} 加入了「{room_name}」",
            "ts": _now(),
        }, exclude=client)
        client.system(f"你加入了「{room_name}」")

    def _handle_leave(self, client: Client, message: dict[str, Any]) -> None:
        room_name = str(message.get("room") or client.current_room or "")
        if room_name not in client.rooms:
            client.error(f"你不在房間「{room_name}」裡")
            return
        with self._lock:
            client.rooms.discard(room_name)
            room = self._rooms.get(room_name)
            if room is not None:
                room.members.discard(client)
            if client.current_room == room_name:
                client.current_room = next(iter(sorted(client.rooms)), None)
        client.system(f"你離開了「{room_name}」")
        self._broadcast(room_name, {
            "type": protocol.SYSTEM,
            "room": room_name,
            "text": f"{client.name} 離開了「{room_name}」",
            "ts": _now(),
        })
        self._prune_empty_rooms()

    def _handle_list_rooms(self, client: Client, message: dict[str, Any]) -> None:
        with self._lock:
            rooms = [{"name": r.name, "users": len(r.members)}
                     for r in sorted(self._rooms.values(), key=lambda r: r.name)]
        client.send({"type": protocol.ROOM_LIST, "rooms": rooms, "ts": _now()})

    def _handle_list_users(self, client: Client, message: dict[str, Any]) -> None:
        room_name = str(message.get("room") or client.current_room or "")
        with self._lock:
            room = self._rooms.get(room_name)
            if room is None:
                client.error(f"沒有這個房間：「{room_name}」")
                return
            users = sorted(c.name for c in room.members)
        client.send({"type": protocol.USER_LIST, "room": room_name,
                     "users": users, "ts": _now()})

    # ------------------------------------------------------------------
    # 工具
    # ------------------------------------------------------------------
    def _clean_text(self, client: Client, raw: Any) -> str | None:
        text = str(raw or "").strip()
        if not text:
            client.error("訊息不能是空的")
            return None
        if len(text) > MAX_TEXT_LEN:
            client.error(f"訊息太長了（上限 {MAX_TEXT_LEN} 字）")
            return None
        return text

    def _broadcast(self, room_name: str, payload: dict[str, Any],
                   exclude: Client | None = None) -> None:
        with self._lock:
            room = self._rooms.get(room_name)
            targets: Iterable[Client] = list(room.members) if room else ()
        for member in targets:
            if member is not exclude:
                member.send(payload)

    def _prune_empty_rooms(self) -> None:
        """清掉沒人的房間，但永遠保留預設房間。"""
        with self._lock:
            empty = [name for name, room in self._rooms.items()
                     if not room.members and name != DEFAULT_ROOM]
            for name in empty:
                del self._rooms[name]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="啟動聊天伺服器")
    parser.add_argument("--host", default=DEFAULT_HOST, help="監聽位址（預設 %(default)s）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help="監聽埠號（預設 %(default)s）")
    parser.add_argument("--verbose", "-v", action="store_true", help="顯示除錯訊息")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    ChatServer(args.host, args.port).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
