"""範例二：三條纏在一起的螺旋 —— 看網路自己把邊界畫出來。

訓練結束後會直接在終端機印出決策邊界，
可以看到網路學到的不是直線，而是三條彎曲的分界。
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from neuralnet import Tensor, Linear, Tanh, Sequential, cross_entropy, accuracy, Adam
from neuralnet.data import spirals, train_test_split, batches

MARKS = ["·", "*", "+"]      # 網路對背景的判斷
POINTS = ["O", "X", "A"]     # 真正的訓練資料點


def draw_boundary(model, X, y, width=61, height=27):
    """把 2D 平面掃一遍，用字元畫出網路現在的判斷。"""
    xs = np.linspace(-1.25, 1.25, width)
    ys = np.linspace(1.25, -1.25, height)
    grid = np.array([[x, y] for y in ys for x in xs])
    pred = model(Tensor(grid)).data.argmax(axis=1).reshape(height, width)

    canvas = [[MARKS[c] for c in row] for row in pred]
    # 把資料點蓋上去，看看它們有沒有落在對的區塊裡
    for (px, py), label in zip(X, y):
        col = int(round((px + 1.25) / 2.5 * (width - 1)))
        row = int(round((1.25 - py) / 2.5 * (height - 1)))
        if 0 <= col < width and 0 <= row < height:
            canvas[row][col] = POINTS[label]

    print("  +" + "-" * width + "+")
    for row in canvas:
        print("  |" + "".join(row) + "|")
    print("  +" + "-" * width + "+")
    print(f"  背景 {' '.join(MARKS)} = 網路的判斷    資料點 {' '.join(POINTS)} = 正確答案")


def main():
    X, y = spirals(n_per_class=260, classes=3, noise=0.14, turns=1.5, seed=3)
    Xtr, ytr, Xte, yte = train_test_split(X, y, test_ratio=0.25, seed=3)
    rng = np.random.default_rng(7)

    model = Sequential(
        Linear(2, 64, rng), Tanh(),
        Linear(64, 64, rng), Tanh(),
        Linear(64, 3, rng),
    )
    optimizer = Adam(model.parameters(), lr=0.02)

    n_params = sum(p.data.size for p in model.parameters())
    print("=" * 62)
    print(f"三螺旋分類    訓練 {len(ytr)} 筆 / 測試 {len(yte)} 筆    參數 {n_params} 個")
    print("=" * 62)
    print("\n  輪次    訓練損失   訓練準確率   測試準確率")

    for epoch in range(1, 121):
        for xb, yb in batches(Xtr, ytr, 32, rng):
            logits = model(Tensor(xb))
            loss = cross_entropy(logits, yb)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

        if epoch % 10 == 0 or epoch == 1:
            tr_logits = model(Tensor(Xtr))
            te_logits = model(Tensor(Xte))
            print(f"  {epoch:4d}    {float(cross_entropy(tr_logits, ytr).data):.4f}"
                  f"       {accuracy(tr_logits, ytr) * 100:5.1f}%"
                  f"       {accuracy(te_logits, yte) * 100:5.1f}%")

    print("\n網路學到的決策邊界：\n")
    draw_boundary(model, Xte, yte)

    final = accuracy(model(Tensor(Xte)), yte)
    print(f"\n  沒看過的測試資料準確率：{final * 100:.1f}%")
    print("  邊界是彎的 —— 這是隱藏層自己長出來的，沒有人告訴它螺旋長什麼樣子。")


if __name__ == "__main__":
    main()
