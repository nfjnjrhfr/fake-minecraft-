"""匯入／匯出：本工具 JSON、CSV，以及 Minecraft 伺服器的 banned-*.json 格式。"""

import csv
import io
import json
from datetime import datetime, timezone

from .models import BanEntry, IP, PLAYER, to_iso

MC_TIME = "%Y-%m-%d %H:%M:%S %z"
MC_FOREVER = "forever"
CSV_FIELDS = ["kind", "target", "reason", "source", "created", "expires", "uuid"]


def _mc_time(moment):
    return moment.astimezone(timezone.utc).strftime(MC_TIME)


def _parse_mc_time(text):
    if text is None:
        return None
    cleaned = text.strip()
    if not cleaned or cleaned.lower() == MC_FOREVER:
        return None
    return datetime.strptime(cleaned, MC_TIME).astimezone(timezone.utc)


# ---------- Minecraft ----------

def to_minecraft(entries, kind):
    """轉成 banned-players.json / banned-ips.json 的結構。"""
    output = []
    for entry in entries:
        if entry.kind != kind:
            continue
        record = {
            "created": _mc_time(entry.created),
            "source": entry.source,
            "expires": MC_FOREVER if entry.expires is None else _mc_time(entry.expires),
            "reason": entry.reason or "Banned by an operator.",
        }
        if kind == PLAYER:
            record["uuid"] = entry.uuid or ""
            record["name"] = entry.target
        else:
            record["ip"] = entry.target
        output.append(record)
    return output


def from_minecraft(raw):
    """讀 banned-players.json / banned-ips.json，自動判斷是哪一種。"""
    entries = []
    for record in raw:
        is_ip = "ip" in record
        entries.append(BanEntry(
            target=record["ip"] if is_ip else record.get("name", ""),
            kind=IP if is_ip else PLAYER,
            reason=record.get("reason", ""),
            source=record.get("source", "console"),
            created=_parse_mc_time(record.get("created")) or None,
            expires=_parse_mc_time(record.get("expires")),
            uuid=record.get("uuid") or None,
        ))
    return entries


def dump_minecraft(entries, kind):
    return json.dumps(to_minecraft(entries, kind), ensure_ascii=False, indent=2) + "\n"


# ---------- CSV ----------

def dump_csv(entries):
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=CSV_FIELDS, lineterminator="\n")
    writer.writeheader()
    for entry in entries:
        writer.writerow({
            "kind": entry.kind,
            "target": entry.target,
            "reason": entry.reason,
            "source": entry.source,
            "created": to_iso(entry.created),
            "expires": to_iso(entry.expires) or "",
            "uuid": entry.uuid or "",
        })
    return buffer.getvalue()


def load_csv(text):
    entries = []
    for row in csv.DictReader(io.StringIO(text)):
        entries.append(BanEntry.from_dict({
            "target": (row.get("target") or "").strip(),
            "kind": (row.get("kind") or PLAYER).strip() or PLAYER,
            "reason": row.get("reason") or "",
            "source": row.get("source") or "import",
            "created": (row.get("created") or "").strip() or None,
            "expires": (row.get("expires") or "").strip() or None,
            "uuid": (row.get("uuid") or "").strip() or None,
        }))
    return entries


# ---------- 本工具自己的 JSON ----------

def dump_json(entries):
    return json.dumps(
        {"version": 1, "entries": [entry.to_dict() for entry in entries]},
        ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def load_json(text):
    raw = json.loads(text)
    if isinstance(raw, dict):
        if "entries" in raw:
            return [BanEntry.from_dict(item) for item in raw["entries"]]
        raise ValueError("JSON 缺少 entries 欄位")
    if raw and isinstance(raw[0], dict) and ("uuid" in raw[0] or "ip" in raw[0] or "name" in raw[0]):
        return from_minecraft(raw)  # 直接餵 Minecraft 檔案也能吃
    return [BanEntry.from_dict(item) for item in raw]
