"""自動微分引擎（autograd）。

整個神經網路的核心只有這一件事：把每次運算記錄成一張圖，
然後從損失值往回走，用連鎖律把梯度算回每一個參數。
反向傳播就是「自我學習」的機制本身 —— 沒有人告訴網路權重該是多少，
是它自己從錯誤量往回推出每個權重該往哪個方向調整。

這裡不依賴任何深度學習框架，只用 numpy 做矩陣運算。
"""

import numpy as np


def _unbroadcast(grad, shape):
    """把梯度縮回原本的形狀。

    前向傳播時 numpy 會自動廣播（例如 bias 的 (1, 4) 被加到 (32, 4)），
    反向傳播就得把多出來的那幾份梯度加總回去。
    """
    if grad.shape == shape:
        return grad
    while grad.ndim > len(shape):
        grad = grad.sum(axis=0)
    for i, size in enumerate(shape):
        if size == 1 and grad.shape[i] != 1:
            grad = grad.sum(axis=i, keepdims=True)
    return grad.reshape(shape)


class Tensor:
    """帶有梯度的多維陣列，會自己記住自己是怎麼被算出來的。"""

    def __init__(self, data, requires_grad=False, _children=(), _op=""):
        self.data = np.asarray(data, dtype=np.float64)
        self.grad = None
        self.requires_grad = requires_grad
        self._prev = tuple(_children)
        self._op = _op
        self._backward = lambda: None

    # ---------------- 基本屬性 ----------------

    @property
    def shape(self):
        return self.data.shape

    def __repr__(self):
        return f"Tensor(shape={self.data.shape}, op={self._op or 'leaf'})"

    def _accumulate(self, grad):
        if not self.requires_grad:
            return
        grad = _unbroadcast(grad, self.data.shape)
        self.grad = grad if self.grad is None else self.grad + grad

    def zero_grad(self):
        self.grad = None

    def _make(self, data, children, op):
        needs = any(c.requires_grad for c in children)
        return Tensor(data, requires_grad=needs, _children=children, _op=op)

    # ---------------- 四則運算 ----------------

    def __add__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other)
        out = self._make(self.data + other.data, (self, other), "+")

        def _backward():
            self._accumulate(out.grad)
            other._accumulate(out.grad)
        out._backward = _backward
        return out

    def __mul__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other)
        out = self._make(self.data * other.data, (self, other), "*")

        def _backward():
            self._accumulate(out.grad * other.data)
            other._accumulate(out.grad * self.data)
        out._backward = _backward
        return out

    def __pow__(self, power):
        assert isinstance(power, (int, float)), "指數只支援常數"
        out = self._make(self.data ** power, (self,), f"**{power}")

        def _backward():
            self._accumulate(out.grad * power * self.data ** (power - 1))
        out._backward = _backward
        return out

    def __matmul__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other)
        out = self._make(self.data @ other.data, (self, other), "@")

        def _backward():
            self._accumulate(out.grad @ other.data.T)
            other._accumulate(self.data.T @ out.grad)
        out._backward = _backward
        return out

    def __neg__(self):
        return self * -1.0

    def __sub__(self, other):
        return self + (-(other if isinstance(other, Tensor) else Tensor(other)))

    def __truediv__(self, other):
        other = other if isinstance(other, Tensor) else Tensor(other)
        return self * (other ** -1.0)

    __radd__ = __add__
    __rmul__ = __mul__

    def __rsub__(self, other):
        return (-self) + other

    def __rtruediv__(self, other):
        return (self ** -1.0) * other

    # ---------------- 形狀 ----------------

    def reshape(self, *shape):
        out = self._make(self.data.reshape(*shape), (self,), "reshape")

        def _backward():
            self._accumulate(out.grad.reshape(self.data.shape))
        out._backward = _backward
        return out

    @property
    def T(self):
        out = self._make(self.data.T, (self,), "T")

        def _backward():
            self._accumulate(out.grad.T)
        out._backward = _backward
        return out

    # ---------------- 歸約 ----------------

    def sum(self, axis=None, keepdims=False):
        out = self._make(self.data.sum(axis=axis, keepdims=keepdims), (self,), "sum")

        def _backward():
            grad = out.grad
            if axis is not None and not keepdims:
                grad = np.expand_dims(grad, axis)
            self._accumulate(np.broadcast_to(grad, self.data.shape).copy())
        out._backward = _backward
        return out

    def mean(self, axis=None, keepdims=False):
        n = self.data.size if axis is None else self.data.shape[axis]
        return self.sum(axis=axis, keepdims=keepdims) * (1.0 / n)

    # ---------------- 逐元素函數 ----------------

    def exp(self):
        out = self._make(np.exp(self.data), (self,), "exp")

        def _backward():
            self._accumulate(out.grad * out.data)
        out._backward = _backward
        return out

    def log(self):
        out = self._make(np.log(self.data), (self,), "log")

        def _backward():
            self._accumulate(out.grad / self.data)
        out._backward = _backward
        return out

    def relu(self):
        out = self._make(np.maximum(self.data, 0.0), (self,), "relu")

        def _backward():
            self._accumulate(out.grad * (self.data > 0))
        out._backward = _backward
        return out

    def tanh(self):
        t = np.tanh(self.data)
        out = self._make(t, (self,), "tanh")

        def _backward():
            self._accumulate(out.grad * (1 - t * t))
        out._backward = _backward
        return out

    def sigmoid(self):
        s = 1.0 / (1.0 + np.exp(-self.data))
        out = self._make(s, (self,), "sigmoid")

        def _backward():
            self._accumulate(out.grad * s * (1 - s))
        out._backward = _backward
        return out

    def log_softmax(self, axis=-1):
        """數值穩定的 log-softmax（先減掉最大值，避免 exp 爆掉）。"""
        shifted = self.data - self.data.max(axis=axis, keepdims=True)
        logsumexp = np.log(np.exp(shifted).sum(axis=axis, keepdims=True))
        result = shifted - logsumexp
        out = self._make(result, (self,), "log_softmax")

        def _backward():
            softmax = np.exp(result)
            self._accumulate(out.grad - softmax * out.grad.sum(axis=axis, keepdims=True))
        out._backward = _backward
        return out

    def softmax(self, axis=-1):
        return self.log_softmax(axis=axis).exp()

    # ---------------- 反向傳播 ----------------

    def backward(self):
        """從這個純量往回算出圖上每個參數的梯度。"""
        assert self.data.size == 1, "只能從純量（例如損失值）開始反向傳播"

        order, seen = [], set()

        def visit(node):
            # 用堆疊而非遞迴，網路再深也不會爆 Python 的遞迴上限。
            stack = [(node, False)]
            while stack:
                current, expanded = stack.pop()
                if expanded:
                    order.append(current)
                    continue
                if id(current) in seen:
                    continue
                seen.add(id(current))
                stack.append((current, True))
                for child in current._prev:
                    stack.append((child, False))

        visit(self)
        self.grad = np.ones_like(self.data)
        for node in reversed(order):
            # 圖裡可能混著常數子樹（例如標籤），它們永遠拿不到梯度，直接跳過。
            if node.grad is not None:
                node._backward()
