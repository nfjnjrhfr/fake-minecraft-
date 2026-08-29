"""最佳化器：拿到梯度之後，決定參數實際要怎麼動。"""

import numpy as np


class Optimizer:
    def __init__(self, parameters, lr):
        self.parameters = list(parameters)
        self.lr = lr

    def zero_grad(self):
        for p in self.parameters:
            p.grad = None

    def step(self):
        raise NotImplementedError


class SGD(Optimizer):
    """隨機梯度下降，可加動量。

    動量讓更新方向帶有慣性，能衝過小坑洞、也能壓掉來回震盪。
    """

    def __init__(self, parameters, lr=0.1, momentum=0.0, weight_decay=0.0):
        super().__init__(parameters, lr)
        self.momentum = momentum
        self.weight_decay = weight_decay
        self.velocity = [np.zeros_like(p.data) for p in self.parameters]

    def step(self):
        for i, p in enumerate(self.parameters):
            if p.grad is None:
                continue
            grad = p.grad + self.weight_decay * p.data
            self.velocity[i] = self.momentum * self.velocity[i] + grad
            p.data -= self.lr * self.velocity[i]


class Adam(Optimizer):
    """Adam：替每個參數各自估計梯度的一階與二階動量，自動調整步伐大小。"""

    def __init__(self, parameters, lr=0.01, betas=(0.9, 0.999), eps=1e-8, weight_decay=0.0):
        super().__init__(parameters, lr)
        self.beta1, self.beta2 = betas
        self.eps = eps
        self.weight_decay = weight_decay
        self.m = [np.zeros_like(p.data) for p in self.parameters]
        self.v = [np.zeros_like(p.data) for p in self.parameters]
        self.t = 0

    def step(self):
        self.t += 1
        for i, p in enumerate(self.parameters):
            if p.grad is None:
                continue
            grad = p.grad + self.weight_decay * p.data
            self.m[i] = self.beta1 * self.m[i] + (1 - self.beta1) * grad
            self.v[i] = self.beta2 * self.v[i] + (1 - self.beta2) * grad * grad
            # 前幾步 m、v 還被零初始化拖著，做偏差修正把它拉回正確尺度。
            m_hat = self.m[i] / (1 - self.beta1 ** self.t)
            v_hat = self.v[i] / (1 - self.beta2 ** self.t)
            p.data -= self.lr * m_hat / (np.sqrt(v_hat) + self.eps)
