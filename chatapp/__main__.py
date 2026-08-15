"""統一進入點：``python -m chatapp <server|client> [選項]``。"""

from __future__ import annotations

import sys

USAGE = """\
用法：python -m chatapp <指令> [選項]

指令：
  server    啟動聊天伺服器
  client    連線到聊天伺服器

範例：
  python -m chatapp server --port 5000
  python -m chatapp client --port 5000 --nick amy

各指令的完整選項請用 --help 查看，例如：
  python -m chatapp server --help"""


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0 if argv else 1

    command, rest = argv[0], argv[1:]
    if command == "server":
        from .server import main as server_main
        return server_main(rest)
    if command == "client":
        from .client import main as client_main
        return client_main(rest)

    print(f"沒有這個指令：{command}\n", file=sys.stderr)
    print(USAGE, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
