"""範例三：辨識手寫數字 —— 真正的影像分類。

每張圖都是「字模 + 隨機平移 + 隨機雜訊」現場生成的，
所以網路看到的每一張都不一樣，它必須學會筆畫的形狀，不能死背。
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from neuralnet import Tensor, Linear, ReLU, Sequential, cross_entropy, accuracy, Adam
from neuralnet.data import digits, train_test_split, batches

SHADES = " .:-=+*#%@"


def show_image(pixels, indent="    "):
    """把 64 個像素值畫成 8x8 的灰階圖。"""
    grid = pixels.reshape(8, 8)
    for row in grid:
        chars = "".join(SHADES[min(int(v * len(SHADES)), len(SHADES) - 1)] * 2 for v in row)
        print(indent + chars)


def main():
    X, y = digits(n_per_class=260, noise=0.22, seed=11)
    Xtr, ytr, Xte, yte = train_test_split(X, y, test_ratio=0.25, seed=11)
    rng = np.random.default_rng(5)

    model = Sequential(
        Linear(64, 64, rng), ReLU(),
        Linear(64, 32, rng), ReLU(),
        Linear(32, 10, rng),
    )
    optimizer = Adam(model.parameters(), lr=0.004, weight_decay=1e-4)

    n_params = sum(p.data.size for p in model.parameters())
    print("=" * 62)
    print(f"手寫數字辨識    訓練 {len(ytr)} 張 / 測試 {len(yte)} 張    參數 {n_params} 個")
    print("=" * 62)
    print("\n  輪次    訓練損失   訓練準確率   測試準確率")

    for epoch in range(1, 41):
        for xb, yb in batches(Xtr, ytr, 64, rng):
            loss = cross_entropy(model(Tensor(xb)), yb)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

        if epoch % 4 == 0 or epoch == 1:
            tr = model(Tensor(Xtr))
            te = model(Tensor(Xte))
            print(f"  {epoch:4d}    {float(cross_entropy(tr, ytr).data):.4f}"
                  f"       {accuracy(tr, ytr) * 100:5.1f}%"
                  f"       {accuracy(te, yte) * 100:5.1f}%")

    logits = model(Tensor(Xte))
    preds = logits.data.argmax(axis=1)
    probs = np.exp(logits.log_softmax().data)

    print("\n每個數字的辨識率：")
    print("  數字   " + "  ".join(f"{d:4d}" for d in range(10)))
    rates = [f"{(preds[yte == d] == d).mean() * 100:5.1f}" for d in range(10)]
    print("  正確率 " + "  ".join(f"{r}" for r in rates))

    print("\n隨便挑三張測試圖，看網路怎麼想：")
    for idx in np.random.default_rng(2).choice(len(yte), 3, replace=False):
        print()
        show_image(Xte[idx])
        top = probs[idx].argsort()[::-1][:3]
        guesses = "   ".join(f"{d} ({probs[idx][d] * 100:.1f}%)" for d in top)
        mark = "正確" if preds[idx] == yte[idx] else f"錯了，答案是 {yte[idx]}"
        print(f"    正解 {yte[idx]}  ->  網路：{guesses}   [{mark}]")

    wrong = np.where(preds != yte)[0]
    print(f"\n  {len(yte)} 張測試圖裡答錯 {len(wrong)} 張，"
          f"準確率 {accuracy(logits, yte) * 100:.1f}%")
    if len(wrong):
        i = wrong[0]
        print(f"\n  看一張它答錯的（正解 {yte[i]}，它猜 {preds[i]}）：")
        show_image(Xte[i], indent="  ")
        print("  雜訊太重的時候它也會看走眼 —— 跟人一樣。")


if __name__ == "__main__":
    main()
