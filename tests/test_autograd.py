"""用數值梯度驗證自動微分算得對不對。

作法：把某個參數推一點點（+h / -h），看損失實際變了多少，
再跟 backward() 算出來的梯度比對。兩者對得上，反向傳播才是對的。
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from neuralnet import Tensor, Linear, ReLU, Tanh, Sequential, cross_entropy, mse_loss  # noqa: E402


def numeric_grad(fn, tensor, h=1e-6):
    """對 tensor 的每個元素做中央差分。"""
    grad = np.zeros_like(tensor.data)
    flat = tensor.data.reshape(-1)
    for i in range(flat.size):
        original = flat[i]
        flat[i] = original + h
        plus = fn().data.item()
        flat[i] = original - h
        minus = fn().data.item()
        flat[i] = original
        grad.reshape(-1)[i] = (plus - minus) / (2 * h)
    return grad


def check(name, fn, tensors, tol=1e-6):
    for t in tensors:
        t.zero_grad()
    loss = fn()
    loss.backward()
    worst = 0.0
    for t in tensors:
        expected = numeric_grad(fn, t)
        actual = t.grad if t.grad is not None else np.zeros_like(t.data)
        scale = np.maximum(np.abs(expected) + np.abs(actual), 1e-8)
        worst = max(worst, float((np.abs(expected - actual) / scale).max()))
    status = "通過" if worst < tol else "失敗"
    print(f"  [{status}] {name:<28} 最大相對誤差 {worst:.2e}")
    return worst < tol


def main():
    rng = np.random.default_rng(0)
    results = []

    print("\n基本運算")
    a = Tensor(rng.normal(size=(3, 4)), requires_grad=True)
    b = Tensor(rng.normal(size=(4, 2)), requires_grad=True)
    c = Tensor(rng.normal(size=(1, 2)), requires_grad=True)
    results.append(check("矩陣乘法 + 廣播加法", lambda: ((a @ b + c) ** 2).sum(), [a, b, c]))
    results.append(check("relu", lambda: (a @ b + c).relu().sum(), [a, b, c]))
    results.append(check("tanh", lambda: (a @ b + c).tanh().sum(), [a, b, c]))
    results.append(check("sigmoid", lambda: (a @ b + c).sigmoid().sum(), [a, b, c]))
    results.append(check("exp / log", lambda: ((a.exp() + 1.0).log()).sum(), [a]))
    results.append(check("除法與負指數", lambda: (1.0 / (a.exp() + 2.0)).sum(), [a]))
    results.append(check("mean 與 reshape", lambda: (a.reshape(2, 6) ** 3).mean(), [a]))
    results.append(check("轉置", lambda: (a.T @ a).sum(), [a]))
    results.append(check("沿軸 sum", lambda: (a.sum(axis=1) ** 2).sum(), [a]))

    print("\n損失函數")
    logits = Tensor(rng.normal(size=(5, 3)), requires_grad=True)
    labels = np.array([0, 2, 1, 1, 0])
    results.append(check("cross_entropy", lambda: cross_entropy(logits, labels), [logits]))
    results.append(check("log_softmax", lambda: logits.log_softmax().sum(), [logits]))
    pred = Tensor(rng.normal(size=(5, 3)), requires_grad=True)
    target = rng.normal(size=(5, 3))
    results.append(check("mse_loss", lambda: mse_loss(pred, target), [pred]))

    print("\n整個網路（兩層隱藏層）")
    net = Sequential(Linear(4, 6, rng), Tanh(), Linear(6, 5, rng), ReLU(), Linear(5, 3, rng))
    x = Tensor(rng.normal(size=(7, 4)))
    y = rng.integers(0, 3, size=7)
    results.append(check("端到端反向傳播", lambda: cross_entropy(net(x), y), net.parameters(), tol=1e-5))

    print("\n共用節點（同一個張量被用兩次，梯度要相加）")
    d = Tensor(rng.normal(size=(3, 3)), requires_grad=True)
    results.append(check("梯度累加", lambda: (d * d + d.tanh()).sum(), [d]))

    passed = sum(results)
    print(f"\n{passed}/{len(results)} 項通過")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
