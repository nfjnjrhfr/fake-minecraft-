#!/usr/bin/env python3
"""一次跑完所有東西：先驗證梯度算得對，再依序跑四個範例。

    python3 train.py            # 全部跑一遍
    python3 train.py xor        # 只跑某一個：xor / spiral / digits / self
    python3 train.py check      # 只做梯度檢查
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

STEPS = [
    ("check",  "梯度檢查（驗證反向傳播是對的）", ROOT / "tests" / "test_autograd.py"),
    ("xor",    "範例一：XOR，為什麼需要隱藏層",   ROOT / "examples" / "01_xor.py"),
    ("spiral", "範例二：三螺旋分類與決策邊界",     ROOT / "examples" / "02_spiral.py"),
    ("digits", "範例三：手寫數字辨識",           ROOT / "examples" / "03_digits.py"),
    ("self",   "範例四：自我學習（強化學習）",     ROOT / "examples" / "04_self_learning.py"),
]


def main():
    wanted = sys.argv[1:]
    steps = [s for s in STEPS if not wanted or s[0] in wanted]
    if not steps:
        print(f"不認得的名稱。可用的有：{', '.join(name for name, _, _ in STEPS)}")
        return 1

    failed = []
    for name, title, script in steps:
        print(f"\n\n{'#' * 62}\n#  {title}\n{'#' * 62}\n")
        result = subprocess.run([sys.executable, str(script)])
        if result.returncode != 0:
            failed.append(name)

    print(f"\n\n{'=' * 62}")
    if failed:
        print(f"以下步驟失敗：{', '.join(failed)}")
        return 1
    print(f"全部完成（{len(steps)} 個步驟）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
