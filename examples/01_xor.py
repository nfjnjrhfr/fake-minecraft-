"""範例一：XOR —— 為什麼神經網路一定要有「隱藏層」。

XOR 沒辦法用一條直線切開。單層網路（等同線性模型）永遠學不會，
加一層隱藏層之後就能學會了。這是「深度」有意義的最短證明。
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from neuralnet import Tensor, Linear, Tanh, Sigmoid, Sequential, binary_cross_entropy, SGD
from neuralnet.data import xor


def train(model, X, y, epochs=4000, lr=0.5):
    optimizer = SGD(model.parameters(), lr=lr, momentum=0.9)
    inputs = Tensor(X)
    history = []
    for epoch in range(epochs):
        pred = model(inputs)
        loss = binary_cross_entropy(pred, y)

        optimizer.zero_grad()
        loss.backward()      # 反向傳播：算出每個權重該往哪走
        optimizer.step()     # 真的走一步

        if epoch % (epochs // 20) == 0:
            history.append((epoch, float(loss.data)))
    return history


def main():
    X, y = xor()
    rng = np.random.default_rng(1)

    print("=" * 58)
    print("XOR：一條直線切不開的問題")
    print("=" * 58)
    print("\n  輸入        期望輸出")
    for xi, yi in zip(X, y):
        print(f"  {xi[0]:.0f}  {xi[1]:.0f}   ->   {yi[0]:.0f}")

    print("\n--- 沒有隱藏層（等同線性模型）---")
    flat = Sequential(Linear(2, 1, rng), Sigmoid())
    history = train(flat, X, y)
    for epoch, loss in history[::5]:
        print(f"  第 {epoch:5d} 輪   loss = {loss:.4f}")
    flat_pred = flat(Tensor(X)).data
    print(f"  最終預測：{np.round(flat_pred.ravel(), 3)}  <- 通通卡在 0.5 附近，學不會")

    print("\n--- 加一層 8 個神經元的隱藏層 ---")
    deep = Sequential(Linear(2, 8, rng), Tanh(), Linear(8, 1, rng), Sigmoid())
    history = train(deep, X, y)
    for epoch, loss in history[::5]:
        print(f"  第 {epoch:5d} 輪   loss = {loss:.4f}")

    pred = deep(Tensor(X)).data
    print("\n  輸入        期望    網路預測    判定")
    correct = 0
    for xi, yi, pi in zip(X, y, pred):
        guess = 1 if pi[0] > 0.5 else 0
        ok = guess == int(yi[0])
        correct += ok
        print(f"  {xi[0]:.0f}  {xi[1]:.0f}   ->    {yi[0]:.0f}      {pi[0]:.4f}      {'正確' if ok else '錯誤'}")
    print(f"\n  答對 {correct}/4 —— 隱藏層讓網路能把平面折彎，XOR 就可分了。")


if __name__ == "__main__":
    main()
