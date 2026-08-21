"""封鎖名單的儲存層：一個 JSON 檔，加上操作紀錄（audit log）。"""

import json
import os
import tempfile

from .models import BanEntry, IP, PLAYER, normalize, now, to_iso

FORMAT_VERSION = 1
AUDIT_LIMIT = 1000
DEFAULT_FILE = os.environ.get("BANLIST_FILE", "banlist.json")


class BanStore(object):
    def __init__(self, path=DEFAULT_FILE):
        self.path = path
        self.entries = []
        self.audit = []

    # ---------- 讀寫 ----------

    def load(self):
        if not os.path.exists(self.path):
            self.entries = []
            self.audit = []
            return self
        with open(self.path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
        if isinstance(raw, list):  # 容忍只有一個陣列的舊檔案
            raw = {"entries": raw}
        self.entries = [BanEntry.from_dict(item) for item in raw.get("entries", [])]
        self.audit = list(raw.get("audit", []))
        return self

    def save(self):
        payload = {
            "version": FORMAT_VERSION,
            "entries": [entry.to_dict() for entry in self.entries],
            "audit": self.audit[-AUDIT_LIMIT:],
        }
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=directory, prefix=".banlist-", suffix=".tmp", delete=False
        )
        try:
            with handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
            os.replace(handle.name, self.path)  # 原子寫入，避免中斷弄壞名單
        except BaseException:
            if os.path.exists(handle.name):
                os.unlink(handle.name)
            raise
        return self

    # ---------- 查詢 ----------

    def find(self, target, kind):
        wanted = (kind, normalize(target, kind))
        for entry in self.entries:
            if entry.key == wanted:
                return entry
        return None

    def matching(self, target, kind=None, at=None):
        """所有命中 target 的有效紀錄（IP 會比對網段）。"""
        hits = []
        for entry in self.entries:
            if kind and entry.kind != kind:
                continue
            if entry.is_active(at) and entry.matches(target):
                hits.append(entry)
        return hits

    def listing(self, kind=None, state="active", at=None):
        result = []
        for entry in self.entries:
            if kind and entry.kind != kind:
                continue
            if state == "active" and not entry.is_active(at):
                continue
            if state == "expired" and entry.is_active(at):
                continue
            result.append(entry)
        result.sort(key=lambda item: (item.kind, item.key[1]))
        return result

    # ---------- 修改 ----------

    def ban(self, target, kind=PLAYER, reason="", source="console", expires=None,
            uuid=None, replace=True):
        existing = self.find(target, kind)
        if existing is not None:
            if not replace:
                raise KeyError("%s %s 已經在名單上" % (kind, target))
            self.entries.remove(existing)
        entry = BanEntry(target=target, kind=kind, reason=reason, source=source,
                         expires=expires, uuid=uuid)
        self.entries.append(entry)
        self._log("ban" if existing is None else "update", entry, source)
        return entry

    def unban(self, target, kind=PLAYER, source="console"):
        entry = self.find(target, kind)
        if entry is None:
            return None
        self.entries.remove(entry)
        self._log("unban", entry, source)
        return entry

    def purge_expired(self, at=None, source="console"):
        stale = [entry for entry in self.entries if not entry.is_active(at)]
        for entry in stale:
            self.entries.remove(entry)
            self._log("purge", entry, source)
        return stale

    def _log(self, action, entry, source):
        self.audit.append({
            "time": to_iso(now()),
            "action": action,
            "kind": entry.kind,
            "target": entry.target,
            "actor": source,
            "reason": entry.reason,
            "expires": to_iso(entry.expires),
        })

    # ---------- 匯入 ----------

    def merge(self, entries, source="import", replace=True):
        """把一批紀錄併進名單，回傳 (新增, 覆蓋, 略過) 三個數量。"""
        added = updated = skipped = 0
        for entry in entries:
            existing = self.find(entry.target, entry.kind)
            if existing is not None:
                if not replace:
                    skipped += 1
                    continue
                self.entries.remove(existing)
                updated += 1
            else:
                added += 1
            self.entries.append(entry)
            self._log("import", entry, source)
        return added, updated, skipped
