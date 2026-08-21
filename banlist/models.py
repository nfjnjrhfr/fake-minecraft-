"""封鎖名單的資料模型。"""

import ipaddress
from datetime import datetime, timezone

PLAYER = "player"
IP = "ip"
KINDS = (PLAYER, IP)


def now():
    """目前時間（UTC，去掉微秒讓輸出穩定）。"""
    return datetime.now(timezone.utc).replace(microsecond=0)


def to_iso(moment):
    if moment is None:
        return None
    return moment.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def from_iso(text):
    if text is None:
        return None
    cleaned = text.strip()
    if cleaned.endswith("Z"):
        cleaned = cleaned[:-1] + "+00:00"
    moment = datetime.fromisoformat(cleaned)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def looks_like_ip(target):
    """判斷輸入是 IP／CIDR 還是玩家名稱。"""
    try:
        ipaddress.ip_network(target.strip(), strict=False)
    except ValueError:
        return False
    return True


def normalize(target, kind):
    cleaned = target.strip()
    if not cleaned:
        raise ValueError("封鎖對象不可為空")
    if kind == IP:
        return str(ipaddress.ip_network(cleaned, strict=False))
    return cleaned.lower()


class BanEntry(object):
    """一筆封鎖紀錄。"""

    __slots__ = ("target", "kind", "reason", "source", "created", "expires", "uuid")

    def __init__(self, target, kind=PLAYER, reason="", source="console",
                 created=None, expires=None, uuid=None):
        if kind not in KINDS:
            raise ValueError("kind 只能是 player 或 ip，收到 %r" % kind)
        self.kind = kind
        self.target = target.strip()
        self.reason = reason or ""
        self.source = source or "console"
        self.created = created or now()
        self.expires = expires
        self.uuid = uuid

    @property
    def key(self):
        """比對用的正規化鍵值（玩家不分大小寫、IP 統一寫法）。"""
        return (self.kind, normalize(self.target, self.kind))

    def is_active(self, at=None):
        if self.expires is None:
            return True
        return (at or now()) < self.expires

    def remaining(self, at=None):
        """剩餘秒數；永久封鎖回傳 None，已過期回傳 0。"""
        if self.expires is None:
            return None
        delta = int((self.expires - (at or now())).total_seconds())
        return max(delta, 0)

    def matches(self, candidate):
        """這筆紀錄是否命中某個玩家名稱或 IP（IP 支援 CIDR 網段）。"""
        cleaned = candidate.strip()
        if self.kind == PLAYER:
            return cleaned.lower() == normalize(self.target, PLAYER)
        try:
            address = ipaddress.ip_address(cleaned)
        except ValueError:
            try:
                network = ipaddress.ip_network(cleaned, strict=False)
            except ValueError:
                return False
            return network.subnet_of(ipaddress.ip_network(normalize(self.target, IP)))
        return address in ipaddress.ip_network(normalize(self.target, IP))

    def to_dict(self):
        data = {
            "target": self.target,
            "kind": self.kind,
            "reason": self.reason,
            "source": self.source,
            "created": to_iso(self.created),
            "expires": to_iso(self.expires),
        }
        if self.uuid:
            data["uuid"] = self.uuid
        return data

    @classmethod
    def from_dict(cls, data):
        return cls(
            target=data["target"],
            kind=data.get("kind", PLAYER),
            reason=data.get("reason", ""),
            source=data.get("source", "console"),
            created=from_iso(data.get("created")) or now(),
            expires=from_iso(data.get("expires")),
            uuid=data.get("uuid"),
        )

    def __repr__(self):
        return "BanEntry(%r, kind=%r, expires=%r)" % (self.target, self.kind, to_iso(self.expires))
