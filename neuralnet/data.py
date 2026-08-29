"""自己生資料集，不需要下載任何檔案。"""

import numpy as np

# 8x8 的數字字模，每個數字八列、每列八格。'#' 是筆畫，'.' 是背景。
DIGIT_GLYPHS = [
    ("..####..", ".##..##.", ".##..##.", ".##..##.", ".##..##.", ".##..##.", "..####..", "........"),  # 0
    ("...##...", "..###...", "...##...", "...##...", "...##...", "...##...", "..####..", "........"),  # 1
    ("..####..", ".##..##.", ".....##.", "....##..", "..##....", ".##.....", ".######.", "........"),  # 2
    ("..####..", ".##..##.", ".....##.", "...###..", ".....##.", ".##..##.", "..####..", "........"),  # 3
    ("....##..", "...###..", "..#.##..", ".##.##..", ".######.", "....##..", "....##..", "........"),  # 4
    (".######.", ".##.....", ".#####..", ".....##.", ".....##.", ".##..##.", "..####..", "........"),  # 5
    ("..####..", ".##..##.", ".##.....", ".#####..", ".##..##.", ".##..##.", "..####..", "........"),  # 6
    (".######.", ".....##.", "....##..", "...##...", "..##....", "..##....", "..##....", "........"),  # 7
    ("..####..", ".##..##.", ".##..##.", "..####..", ".##..##.", ".##..##.", "..####..", "........"),  # 8
    ("..####..", ".##..##.", ".##..##.", "..#####.", ".....##.", ".##..##.", "..####..", "........"),  # 9
]


def _glyph_to_grid(rows):
    """把八列字串變成 8x8 的 0/1 網格。"""
    return np.array([[1.0 if ch == "#" else 0.0 for ch in row] for row in rows])


def digits(n_per_class=180, noise=0.18, seed=0):
    """手寫數字風格的資料集：字模 + 隨機平移 + 隨機雜訊。

    每張圖都是獨一無二的，網路必須學會「筆畫的形狀」，
    不能靠死背某一張圖。
    """
    rng = np.random.default_rng(seed)
    templates = [_glyph_to_grid(g) for g in DIGIT_GLYPHS]
    images, labels = [], []
    for label, template in enumerate(templates):
        for _ in range(n_per_class):
            # 先墊一圈空白再切窗，就能乾淨地平移而不會把邊緣像素複製出去
            padded = np.zeros((10, 10))
            padded[1:9, 1:9] = template
            dy, dx = rng.integers(-1, 2), rng.integers(-1, 2)
            img = padded[1 + dy:9 + dy, 1 + dx:9 + dx]
            img = img * rng.uniform(0.7, 1.0)          # 下筆輕重不同
            img = img + rng.normal(0, noise, (8, 8))   # 紙張雜訊
            images.append(np.clip(img, 0, 1).reshape(-1))
            labels.append(label)

    X = np.array(images)
    y = np.array(labels)
    order = rng.permutation(len(y))
    return X[order], y[order]


def spirals(n_per_class=200, classes=3, noise=0.18, turns=1.35, seed=0):
    """互相纏繞的螺旋。線性模型完全做不到，一定要有隱藏層。

    turns 是每條螺旋繞幾圈；繞得愈多圈，類別交錯得愈厲害，也就愈難學。
    """
    rng = np.random.default_rng(seed)
    X, y = [], []
    for c in range(classes):
        radius = np.linspace(0.05, 1.0, n_per_class)
        offset = c * 2 * np.pi / classes
        theta = np.linspace(offset, offset + turns * 2 * np.pi, n_per_class)
        theta = theta + rng.normal(0, noise, n_per_class)
        X.append(np.stack([radius * np.sin(theta), radius * np.cos(theta)], axis=1))
        y.append(np.full(n_per_class, c))
    X = np.concatenate(X)
    y = np.concatenate(y)
    order = rng.permutation(len(y))
    return X[order], y[order]


def xor():
    """經典的 XOR：單層感知器解不了，是「需要深度」最短的證明。"""
    X = np.array([[0.0, 0.0], [0.0, 1.0], [1.0, 0.0], [1.0, 1.0]])
    y = np.array([[0.0], [1.0], [1.0], [0.0]])
    return X, y


def train_test_split(X, y, test_ratio=0.2, seed=0):
    rng = np.random.default_rng(seed)
    order = rng.permutation(len(y))
    cut = int(len(y) * (1 - test_ratio))
    train, test = order[:cut], order[cut:]
    return X[train], y[train], X[test], y[test]


def batches(X, y, batch_size, rng):
    """每個 epoch 重新洗牌，切成小批次餵給網路。"""
    order = rng.permutation(len(y))
    for start in range(0, len(order), batch_size):
        idx = order[start:start + batch_size]
        yield X[idx], y[idx]
