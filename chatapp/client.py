"""聊天客戶端（終端機介面）。

用法::

    python -m chatapp client --host 127.0.0.1 --port 5000 --nick amy

接收與輸入分開跑：背景執行緒負責印出伺服器來的訊息，
主執行緒負責讀 stdin。輸入以 ``/`` 開頭的是指令，其餘直接送到目前房間。
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import time
from typing import Any

from . import protocol
from .protocol import LineReader, ProtocolError

HELP_TEXT = """\
可用指令：
  /join <房間>          加入並切換到某個房間
  /leave [房間]         離開房間（預設為目前房間）
  /rooms                列出所有房間
  /users [房間]         列出房間內的成員
  /msg <暱稱> <訊息>    傳私訊（別名：/w、/tell）
  /me <動作>            動作訊息，例如 /me 在喝咖啡
  /friend <暱稱>        送出好友邀請
  /friends              查看好友清單與邀請
  /faccept <暱稱>       接受好友邀請
  /fdecline <暱稱>      拒絕好友邀請
  /fremove <暱稱>       刪除好友
  /nick                 顯示自己的暱稱
  /help                 顯示這份說明
  /quit                 離開聊天室
其他輸入都會直接送到目前所在的房間。"""


class Colors:
    """ANSI 顏色；非 tty（例如被導向到檔案）時自動停用。"""

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled

    def _wrap(self, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.enabled else text

    def dim(self, text: str) -> str:
        return self._wrap("2", text)

    def bold(self, text: str) -> str:
        return self._wrap("1", text)

    def green(self, text: str) -> str:
        return self._wrap("32", text)

    def yellow(self, text: str) -> str:
        return self._wrap("33", text)

    def cyan(self, text: str) -> str:
        return self._wrap("36", text)

    def red(self, text: str) -> str:
        return self._wrap("31", text)


class ChatClient:
    def __init__(self, host: str, port: int, nick: str,
                 color: bool | None = None, out=sys.stdout) -> None:
        self.host = host
        self.port = port
        self.nick = nick
        self.current_room = "lobby"
        self.out = out
        self.c = Colors(out.isatty() if color is None else color)
        self.sock: socket.socket | None = None
        self._running = threading.Event()

    # ------------------------------------------------------------------
    def connect(self) -> None:
        self.sock = socket.create_connection((self.host, self.port), timeout=10)
        self.sock.settimeout(None)
        self._running.set()
        protocol.send(self.sock, {"type": protocol.LOGIN, "nick": self.nick})

    def close(self) -> None:
        self._running.clear()
        if self.sock is not None:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def send(self, message: dict[str, Any]) -> None:
        if self.sock is None:
            raise RuntimeError("尚未連線")
        try:
            protocol.send(self.sock, message)
        except OSError as exc:
            self._print(self.c.red(f"送出失敗：{exc}"))
            self._running.clear()

    # ------------------------------------------------------------------
    # 接收
    # ------------------------------------------------------------------
    def receive_loop(self) -> None:
        assert self.sock is not None
        try:
            for message in LineReader(self.sock):
                self.render(message)
                if message.get("type") == protocol.BYE:
                    break
        except (ProtocolError, OSError) as exc:
            if self._running.is_set():
                self._print(self.c.red(f"連線中斷：{exc}"))
        finally:
            self._running.clear()
            self._print(self.c.dim("（連線已關閉，按 Enter 離開）"))

    def render(self, message: dict[str, Any]) -> None:
        mtype = message.get("type")
        stamp = self.c.dim(_fmt_time(message.get("ts")))

        if mtype == protocol.CHAT:
            sender = message.get("sender", "?")
            who = self.c.bold(sender) if sender != self.nick else self.c.green(sender)
            room = self.c.dim(f"[{message.get('room', '?')}]")
            self._print(f"{stamp} {room} {who}: {message.get('text', '')}")

        elif mtype == protocol.PRIVATE:
            sender, to = message.get("sender", "?"), message.get("to", "?")
            if sender == self.nick:
                self._print(f"{stamp} {self.c.cyan(f'-> {to}')}: {message.get('text', '')}")
            else:
                self._print(f"{stamp} {self.c.cyan(f'{sender} 悄悄說')}: {message.get('text', '')}")

        elif mtype == protocol.WELCOME:
            self.nick = message.get("nick", self.nick)
            self.current_room = message.get("room", self.current_room)
            self._print(self.c.green(f"已連線，你的暱稱是 {self.nick}"))
            if message.get("motd"):
                self._print(self.c.dim(message["motd"]))

        elif mtype == protocol.SYSTEM:
            self._print(f"{stamp} {self.c.yellow('* ' + str(message.get('text', '')))}")

        elif mtype == protocol.ERROR:
            self._print(f"{stamp} {self.c.red('! ' + str(message.get('text', '')))}")

        elif mtype == protocol.ROOM_LIST:
            rooms = message.get("rooms", [])
            if not rooms:
                self._print(self.c.dim("目前沒有任何房間"))
            else:
                self._print(self.c.bold("房間列表："))
                for room in rooms:
                    self._print(f"  {room.get('name')} （{room.get('users')} 人）")

        elif mtype == protocol.USER_LIST:
            users = ", ".join(message.get("users", [])) or "（沒有人）"
            self._print(self.c.bold(f"「{message.get('room')}」的成員：") + " " + users)

        elif mtype == protocol.HISTORY:
            msgs = message.get("messages", [])
            if msgs:
                self._print(self.c.dim(f"--- 「{message.get('room')}」最近 {len(msgs)} 則訊息 ---"))
                for msg in msgs:
                    self.render(msg)
                self._print(self.c.dim("--- 以上為歷史紀錄 ---"))

        elif mtype == protocol.FRIEND_LIST:
            friends = message.get("friends", [])
            incoming = message.get("incoming", [])
            outgoing = message.get("outgoing", [])
            self._print(self.c.bold("好友清單："))
            if not friends:
                self._print(self.c.dim("  （還沒有好友，用 /friend <暱稱> 送出邀請）"))
            for f in friends:
                mark = self.c.green("●") if f.get("online") else self.c.dim("○")
                self._print(f"  {mark} {f.get('nick')}")
            if incoming:
                self._print(self.c.yellow(
                    f"  待回應的邀請：{', '.join(incoming)}（/faccept 或 /fdecline）"))
            if outgoing:
                self._print(self.c.dim(f"  已送出邀請：{', '.join(outgoing)}"))

        elif mtype == protocol.FRIEND_EVENT:
            event, nick = message.get("event"), message.get("nick", "?")
            texts = {
                "request": f"「{nick}」想加你為好友（/faccept {nick} 接受）",
                "accepted": f"「{nick}」接受了你的好友邀請！",
                "declined": f"「{nick}」婉拒了你的好友邀請",
                "removed": f"「{nick}」將你從好友移除了",
                "online": f"好友「{nick}」上線了",
                "offline": f"好友「{nick}」下線了",
            }
            text = texts.get(str(event))
            if text:
                self._print(f"{stamp} {self.c.yellow('* ' + text)}")

        elif mtype == protocol.BYE:
            self._print(self.c.dim(str(message.get("text", "再見！"))))

        else:
            self._print(self.c.dim(f"（未知訊息：{message}）"))

    def _print(self, text: str) -> None:
        print(text, file=self.out, flush=True)

    # ------------------------------------------------------------------
    # 輸入
    # ------------------------------------------------------------------
    def handle_input(self, line: str) -> bool:
        """處理一行使用者輸入；回傳 False 代表要離開。"""
        line = line.strip()
        if not line:
            return True
        if not line.startswith("/"):
            self.send({"type": protocol.CHAT, "room": self.current_room, "text": line})
            return True

        command, _, rest = line[1:].partition(" ")
        command = command.lower()
        rest = rest.strip()

        if command in ("quit", "exit", "q"):
            self.send({"type": protocol.QUIT})
            return False

        if command == "help":
            self._print(HELP_TEXT)

        elif command == "join":
            if not rest:
                self._print(self.c.red("用法：/join <房間>"))
            else:
                room = rest.split()[0]
                self.current_room = room
                self.send({"type": protocol.JOIN, "room": room})

        elif command == "leave":
            room = rest.split()[0] if rest else self.current_room
            self.send({"type": protocol.LEAVE, "room": room})

        elif command == "rooms":
            self.send({"type": protocol.LIST_ROOMS})

        elif command == "users":
            self.send({"type": protocol.LIST_USERS,
                       "room": rest.split()[0] if rest else self.current_room})

        elif command in ("msg", "w", "tell"):
            target, _, text = rest.partition(" ")
            if not target or not text.strip():
                self._print(self.c.red("用法：/msg <暱稱> <訊息>"))
            else:
                self.send({"type": protocol.PRIVATE, "to": target, "text": text.strip()})

        elif command == "me":
            if not rest:
                self._print(self.c.red("用法：/me <動作>"))
            else:
                self.send({"type": protocol.CHAT, "room": self.current_room,
                           "text": f"* {self.nick} {rest}"})

        elif command in ("friend", "fadd"):
            if not rest:
                self._print(self.c.red("用法：/friend <暱稱>"))
            else:
                self.send({"type": protocol.FRIEND_ADD, "to": rest.split()[0]})

        elif command == "friends":
            self.send({"type": protocol.LIST_FRIENDS})

        elif command == "faccept":
            if not rest:
                self._print(self.c.red("用法：/faccept <暱稱>"))
            else:
                self.send({"type": protocol.FRIEND_ACCEPT, "nick": rest.split()[0]})

        elif command == "fdecline":
            if not rest:
                self._print(self.c.red("用法：/fdecline <暱稱>"))
            else:
                self.send({"type": protocol.FRIEND_DECLINE, "nick": rest.split()[0]})

        elif command == "fremove":
            if not rest:
                self._print(self.c.red("用法：/fremove <暱稱>"))
            else:
                self.send({"type": protocol.FRIEND_REMOVE, "nick": rest.split()[0]})

        elif command == "nick":
            self._print(self.c.dim(f"你的暱稱是 {self.nick}，目前房間「{self.current_room}」"))

        else:
            self._print(self.c.red(f"沒有這個指令：/{command}（試試 /help）"))

        return True

    def run(self) -> None:
        self.connect()
        reader = threading.Thread(target=self.receive_loop, name="receive", daemon=True)
        reader.start()
        time.sleep(0.1)  # 讓歡迎訊息先印出來，畫面比較整齊
        self._print(self.c.dim("輸入 /help 看指令，/quit 離開。"))
        try:
            while self._running.is_set():
                try:
                    line = input()
                except EOFError:
                    break
                if not self._running.is_set():
                    break
                if not self.handle_input(line):
                    break
        except KeyboardInterrupt:
            self._print("")
        finally:
            self.close()
            reader.join(timeout=1)


def _fmt_time(ts: Any) -> str:
    try:
        return time.strftime("%H:%M:%S", time.localtime(float(ts)))
    except (TypeError, ValueError):
        return time.strftime("%H:%M:%S")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="連線到聊天伺服器")
    parser.add_argument("--host", default="127.0.0.1", help="伺服器位址（預設 %(default)s）")
    parser.add_argument("--port", type=int, default=5000, help="伺服器埠號（預設 %(default)s）")
    parser.add_argument("--nick", help="暱稱（未指定會提示輸入）")
    parser.add_argument("--no-color", action="store_true", help="關閉彩色輸出")
    args = parser.parse_args(argv)

    nick = args.nick or input("請輸入暱稱：").strip()
    if not nick:
        print("暱稱不能是空的", file=sys.stderr)
        return 1

    client = ChatClient(args.host, args.port, nick,
                        color=False if args.no_color else None)
    try:
        client.run()
    except OSError as exc:
        print(f"連線失敗：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
