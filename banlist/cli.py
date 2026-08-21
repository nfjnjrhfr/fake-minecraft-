"""banlist：自己伺服器用的封鎖名單管理 CLI。"""

import argparse
import getpass
import json
import os
import sys
from datetime import timedelta

from . import formats
from .duration import format_duration, parse_duration
from .models import IP, PLAYER, BanEntry, from_iso, looks_like_ip, now, to_iso
from .store import DEFAULT_FILE, BanStore


def _actor(args):
    if args.by:
        return args.by
    try:
        return getpass.getuser()
    except Exception:
        return "console"


def _kind(args, target):
    if getattr(args, "ip", False):
        return IP
    if getattr(args, "player", False):
        return PLAYER
    return IP if looks_like_ip(target) else PLAYER


def _expiry(args):
    """--until 優先於 --for；兩者都沒給就是永久封鎖。"""
    if args.until:
        moment = from_iso(args.until)
        if moment <= now():
            raise SystemExit("錯誤：--until 的時間已經過去了")
        return moment
    seconds = parse_duration(args.duration) if args.duration else None
    if seconds is None:
        return None
    return now() + timedelta(seconds=seconds)


def _describe(entry, at=None):
    remaining = entry.remaining(at)
    if remaining is None:
        window = "永久"
    elif remaining == 0:
        window = "已過期（%s）" % to_iso(entry.expires)
    else:
        window = "剩 %s（到 %s）" % (format_duration(remaining), to_iso(entry.expires))
    reason = entry.reason or "（未填原因）"
    return "%-6s %-24s %-28s %s [by %s]" % (entry.kind, entry.target, window, reason, entry.source)


def _open(args):
    return BanStore(args.file).load()


# ---------- 各個子指令 ----------

def cmd_ban(args):
    store = _open(args)
    target = args.target
    kind = _kind(args, target)
    expires = _expiry(args)
    entry = store.ban(target, kind=kind, reason=args.reason, source=_actor(args),
                      expires=expires, uuid=args.uuid)
    store.save()
    print("已封鎖 %s" % _describe(entry))
    return 0


def cmd_unban(args):
    store = _open(args)
    kind = _kind(args, args.target)
    entry = store.unban(args.target, kind=kind, source=_actor(args))
    if entry is None:
        print("%s %s 不在名單上" % (kind, args.target), file=sys.stderr)
        return 1
    store.save()
    print("已解除封鎖 %s %s" % (entry.kind, entry.target))
    return 0


def cmd_list(args):
    store = _open(args)
    kind = IP if args.ip else PLAYER if args.player else None
    entries = store.listing(kind=kind, state=args.state)
    if args.json:
        print(formats.dump_json(entries), end="")
        return 0
    if not entries:
        print("（沒有符合條件的紀錄）")
        return 0
    for entry in entries:
        print(_describe(entry))
    print("\n合計 %d 筆（%s）" % (len(entries), args.state))
    return 0


def cmd_check(args):
    """有被封鎖時 exit code 為 1，方便接在伺服器腳本裡用。"""
    store = _open(args)
    hits = []
    for target in args.targets:
        hits.extend(store.matching(target))
    if not hits:
        if not args.quiet:
            print("沒有被封鎖")
        return 0
    if not args.quiet:
        for entry in hits:
            print("命中：%s" % _describe(entry))
    return 1


def cmd_purge(args):
    store = _open(args)
    stale = store.purge_expired(source=_actor(args))
    if not stale:
        print("沒有過期紀錄可清除")
        return 0
    store.save()
    for entry in stale:
        print("已清除 %s %s" % (entry.kind, entry.target))
    print("\n共清除 %d 筆" % len(stale))
    return 0


def cmd_log(args):
    store = _open(args)
    records = store.audit[-args.number:]
    if args.json:
        print(json.dumps(records, ensure_ascii=False, indent=2))
        return 0
    if not records:
        print("（尚無操作紀錄）")
        return 0
    for record in records:
        print("%s  %-6s %-6s %-24s by %s  %s" % (
            record["time"], record["action"], record["kind"],
            record["target"], record["actor"], record.get("reason", "")))
    return 0


def cmd_export(args):
    store = _open(args)
    entries = store.listing(state=args.state)
    if args.format == "minecraft":
        if not args.out:
            raise SystemExit("錯誤：匯出 minecraft 格式需要 --out <伺服器資料夾>")
        os.makedirs(args.out, exist_ok=True)
        for kind, name in ((PLAYER, "banned-players.json"), (IP, "banned-ips.json")):
            path = os.path.join(args.out, name)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(formats.dump_minecraft(entries, kind))
            print("已寫出 %s" % path)
        return 0

    text = formats.dump_csv(entries) if args.format == "csv" else formats.dump_json(entries)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text)
        print("已寫出 %s（%d 筆）" % (args.out, len(entries)))
    else:
        print(text, end="")
    return 0


def cmd_import(args):
    store = _open(args)
    with open(args.path, "r", encoding="utf-8") as handle:
        text = handle.read()

    fmt = args.format
    if fmt == "auto":
        fmt = "csv" if args.path.lower().endswith(".csv") else "json"
    if fmt == "csv":
        entries = formats.load_csv(text)
    elif fmt == "minecraft":
        entries = formats.from_minecraft(json.loads(text))
    else:
        entries = formats.load_json(text)

    entries = [entry for entry in entries if entry.target]
    added, updated, skipped = store.merge(entries, source=_actor(args), replace=not args.no_replace)
    store.save()
    print("匯入完成：新增 %d、覆蓋 %d、略過 %d" % (added, updated, skipped))
    return 0


# ---------- 參數 ----------

def build_parser():
    parser = argparse.ArgumentParser(
        prog="banlist",
        description="管理自己伺服器的玩家／IP 封鎖名單（只動自己的資料，不影響他人裝置）。")
    parser.add_argument("-f", "--file", default=DEFAULT_FILE,
                        help="名單檔案路徑（預設 %(default)s，也可用 BANLIST_FILE 環境變數）")
    subparsers = parser.add_subparsers(dest="command")

    def add_kind_flags(sub):
        group = sub.add_mutually_exclusive_group()
        group.add_argument("--ip", action="store_true", help="強制當成 IP／CIDR")
        group.add_argument("--player", action="store_true", help="強制當成玩家名稱")

    ban = subparsers.add_parser("ban", help="新增或更新一筆封鎖")
    ban.add_argument("target", help="玩家名稱、IP 或 CIDR 網段")
    ban.add_argument("-r", "--reason", default="", help="封鎖原因")
    ban.add_argument("-d", "--for", dest="duration", help="期限，例如 30m / 7d / 1w2d（省略＝永久）")
    ban.add_argument("-u", "--until", help="到期時間（ISO 格式，例如 2026-01-01T00:00:00Z）")
    ban.add_argument("--by", help="執行者名稱（預設為目前系統帳號）")
    ban.add_argument("--uuid", help="玩家 UUID（匯出 Minecraft 格式時會用到）")
    add_kind_flags(ban)
    ban.set_defaults(func=cmd_ban)

    unban = subparsers.add_parser("unban", help="解除封鎖")
    unban.add_argument("target")
    unban.add_argument("--by")
    add_kind_flags(unban)
    unban.set_defaults(func=cmd_unban)

    listing = subparsers.add_parser("list", help="列出名單")
    listing.add_argument("--state", choices=("active", "expired", "all"), default="active")
    listing.add_argument("--json", action="store_true", help="輸出 JSON")
    add_kind_flags(listing)
    listing.set_defaults(func=cmd_list)

    check = subparsers.add_parser("check", help="查詢某人／某 IP 是否被封鎖（被封鎖時 exit code = 1）")
    check.add_argument("targets", nargs="+")
    check.add_argument("-q", "--quiet", action="store_true", help="只用 exit code 回報")
    check.set_defaults(func=cmd_check)

    purge = subparsers.add_parser("purge", help="清掉已過期的紀錄")
    purge.add_argument("--by")
    purge.set_defaults(func=cmd_purge)

    log = subparsers.add_parser("log", help="查看操作紀錄")
    log.add_argument("-n", "--number", type=int, default=20)
    log.add_argument("--json", action="store_true")
    log.set_defaults(func=cmd_log)

    export = subparsers.add_parser("export", help="匯出名單")
    export.add_argument("--format", choices=("json", "csv", "minecraft"), default="json")
    export.add_argument("-o", "--out", help="輸出檔案；minecraft 格式請給資料夾")
    export.add_argument("--state", choices=("active", "expired", "all"), default="active")
    export.set_defaults(func=cmd_export)

    importer = subparsers.add_parser("import", help="匯入名單（可吃 Minecraft 的 banned-*.json）")
    importer.add_argument("path")
    importer.add_argument("--format", choices=("auto", "json", "csv", "minecraft"), default="auto")
    importer.add_argument("--no-replace", action="store_true", help="已存在的紀錄就略過，不覆蓋")
    importer.add_argument("--by")
    importer.set_defaults(func=cmd_import)

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return 0
    try:
        return args.func(args)
    except (ValueError, KeyError, OSError) as error:
        print("錯誤：%s" % error, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
