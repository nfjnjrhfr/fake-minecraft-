"""網路層、激活函數與損失函數。"""

import numpy as np

from .tensor import Tensor


class Module:
    """所有網路元件的基底：知道自己有哪些可訓練參數。"""

    def parameters(self):
        params = []
        for value in vars(self).values():
            if isinstance(value, Tensor) and value.requires_grad:
                params.append(value)
            elif isinstance(value, Module):
                params.extend(value.parameters())
            elif isinstance(value, (list, tuple)):
                for item in value:
                    if isinstance(item, Module):
                        params.extend(item.parameters())
        return params

    def zero_grad(self):
        for p in self.parameters():
            p.zero_grad()

    def __call__(self, x):
        return self.forward(x)

    def forward(self, x):
        raise NotImplementedError


class Linear(Module):
    """全連接層：y = xW + b。

    初始化用 He initialization（除以 sqrt(fan_in/2)），
    這樣訊號經過很多層 ReLU 之後不會愈來愈小或愈來愈大。
    """

    def __init__(self, in_features, out_features, rng=None):
        rng = rng or np.random.default_rng()
        scale = np.sqrt(2.0 / in_features)
        self.weight = Tensor(rng.normal(0, scale, (in_features, out_features)), requires_grad=True)
        self.bias = Tensor(np.zeros((1, out_features)), requires_grad=True)

    def forward(self, x):
        return x @ self.weight + self.bias


class ReLU(Module):
    def forward(self, x):
        return x.relu()


class Tanh(Module):
    def forward(self, x):
        return x.tanh()


class Sigmoid(Module):
    def forward(self, x):
        return x.sigmoid()


class Sequential(Module):
    """把好幾層串起來，資料依序流過去。"""

    def __init__(self, *layers):
        self.layers = list(layers)

    def forward(self, x):
        for layer in self.layers:
            x = layer(x)
        return x


# ---------------- 損失函數 ----------------

def mse_loss(pred, target):
    """均方誤差，用在回歸問題。"""
    target = target if isinstance(target, Tensor) else Tensor(target)
    return ((pred - target) ** 2).mean()


def binary_cross_entropy(pred, target, eps=1e-9):
    """二元交叉熵；pred 必須已經過 sigmoid，落在 (0, 1)。"""
    target = target if isinstance(target, Tensor) else Tensor(target)
    return -((target * (pred + eps).log()) + ((1 - target) * (1 - pred + eps).log())).mean()


def cross_entropy(logits, labels):
    """多類別交叉熵。

    直接吃未經 softmax 的 logits，內部走 log-softmax，
    比先算 softmax 再取 log 穩定得多。
    """
    labels = np.asarray(labels, dtype=np.int64)
    log_probs = logits.log_softmax(axis=-1)

    # 用 one-hot 相乘來挑出正確類別的 log 機率，梯度就自然流回去了。
    onehot = np.zeros(logits.shape, dtype=np.float64)
    onehot[np.arange(len(labels)), labels] = 1.0
    return -(log_probs * Tensor(onehot)).sum() * (1.0 / len(labels))


def accuracy(logits, labels):
    return float((logits.data.argmax(axis=-1) == np.asarray(labels)).mean())
