"""把 "7d"、"2h30m"、"perm" 這類字串轉成秒數。"""

import re

UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}

PERMANENT_WORDS = {"perm", "permanent", "forever", "never", "inf", "infinite"}

_TOKEN = re.compile(r"(\d+)\s*([smhdw])")


def parse_duration(text):
    """回傳秒數；永久封鎖回傳 None。

    >>> parse_duration("7d")
    604800
    >>> parse_duration("1h30m")
    5400
    >>> parse_duration("forever") is None
    True
    """
    if text is None:
        return None
    cleaned = text.strip().lower()
    if cleaned in PERMANENT_WORDS:
        return None
    if not cleaned:
        raise ValueError("時間長度不可為空字串")

    total = 0
    pos = 0
    for match in _TOKEN.finditer(cleaned):
        if match.start() != pos:
            raise ValueError("無法解析的時間長度: %r" % text)
        total += int(match.group(1)) * UNITS[match.group(2)]
        pos = match.end()
    if pos != len(cleaned) or total == 0:
        raise ValueError("無法解析的時間長度: %r" % text)
    return total


def format_duration(seconds):
    """把秒數印成人看得懂的長度。"""
    if seconds is None:
        return "永久"
    if seconds <= 0:
        return "0s"
    parts = []
    for name, size in (("w", 604800), ("d", 86400), ("h", 3600), ("m", 60), ("s", 1)):
        count, seconds = divmod(seconds, size)
        if count:
            parts.append("%d%s" % (count, name))
    return "".join(parts)
