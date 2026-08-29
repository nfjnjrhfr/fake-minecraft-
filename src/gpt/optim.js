// AdamW + 暖身/餘弦衰減學習率排程（跟訓練大型語言模型用的是同一套）
export class AdamW {
  constructor(params, { lr = 3e-3, beta1 = 0.9, beta2 = 0.95, eps = 1e-8, weightDecay = 0.01 } = {}) {
    this.params = params;
    this.cfg = { lr, beta1, beta2, eps, weightDecay };
    this.m = params.map((p) => new Float64Array(p.size));
    this.v = params.map((p) => new Float64Array(p.size));
    this.t = 0;
  }

  step(lr = this.cfg.lr) {
    const { beta1, beta2, eps, weightDecay } = this.cfg;
    this.t++;
    const bc1 = 1 - Math.pow(beta1, this.t);
    const bc2 = 1 - Math.pow(beta2, this.t);
    this.params.forEach((p, i) => {
      if (!p.grad) return;
      const m = this.m[i];
      const v = this.v[i];
      const decay = p.shape.length > 1 ? weightDecay : 0; // 偏置與 LayerNorm 不做權重衰減
      for (let k = 0; k < p.data.length; k++) {
        const g = p.grad[k];
        m[k] = beta1 * m[k] + (1 - beta1) * g;
        v[k] = beta2 * v[k] + (1 - beta2) * g * g;
        p.data[k] -= lr * ((m[k] / bc1) / (Math.sqrt(v[k] / bc2) + eps) + decay * p.data[k]);
      }
    });
  }
}

/** 前面線性暖身，之後餘弦衰減到 lr 的 10% */
export function lrSchedule(step, totalSteps, baseLr, warmup = 100) {
  if (step < warmup) return (baseLr * (step + 1)) / warmup;
  const p = (step - warmup) / Math.max(1, totalSteps - warmup);
  return baseLr * (0.1 + 0.9 * 0.5 * (1 + Math.cos(Math.PI * Math.min(1, p))));
}
