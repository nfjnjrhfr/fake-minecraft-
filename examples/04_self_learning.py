"""範例四：自我學習 —— 沒有標準答案，網路自己摸索出策略。

前面三個範例都是「監督式學習」：每筆資料都附了正確答案，
網路只要把答案背對就好。

這一個不一樣。這裡沒有任何人示範怎麼做，
環境只會告訴它「你還活著（+1 分）」或「你倒了（結束）」。
網路必須自己試、自己錯、自己從分數裡推論出哪些動作是好的。
這就是強化學習（reinforcement learning），也是真正意義上的自我學習。

任務是倒立擺：一根桿子立在會左右滑動的推車上，
每一步只能選「往左推」或「往右推」，目標是讓桿子不要倒。
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from neuralnet import Tensor, Linear, Tanh, Sequential, Adam

MAX_STEPS = 200
SOLVED = 195.0      # 最近 30 場平均撐過 195 步就算學會了


class CartPole:
    """倒立擺環境，物理方程式直接寫在這裡，不依賴任何套件。

    狀態有四個數字：推車位置、推車速度、桿子角度、桿子角速度。
    """

    gravity = 9.8
    cart_mass = 1.0
    pole_mass = 0.1
    pole_half_length = 0.5
    force = 10.0
    dt = 0.02
    x_limit = 2.4
    angle_limit = 12 * np.pi / 180     # 桿子傾斜超過 12 度就算倒了

    def __init__(self, seed=0):
        self.rng = np.random.default_rng(seed)
        self.state = None

    def reset(self):
        # 每場都從「幾乎直立、但有一點點隨機偏差」開始
        self.state = self.rng.uniform(-0.05, 0.05, size=4)
        return self.state.copy()

    def step(self, action):
        x, x_dot, theta, theta_dot = self.state
        force = self.force if action == 1 else -self.force
        total_mass = self.cart_mass + self.pole_mass
        pole_ml = self.pole_mass * self.pole_half_length
        cos_t, sin_t = np.cos(theta), np.sin(theta)

        temp = (force + pole_ml * theta_dot ** 2 * sin_t) / total_mass
        theta_acc = ((self.gravity * sin_t - cos_t * temp) /
                     (self.pole_half_length * (4.0 / 3.0 - self.pole_mass * cos_t ** 2 / total_mass)))
        x_acc = temp - pole_ml * theta_acc * cos_t / total_mass

        # 半隱式尤拉法積分
        x += self.dt * x_dot
        x_dot += self.dt * x_acc
        theta += self.dt * theta_dot
        theta_dot += self.dt * theta_acc
        self.state = np.array([x, x_dot, theta, theta_dot])

        done = abs(x) > self.x_limit or abs(theta) > self.angle_limit
        return self.state.copy(), 1.0, done     # 只要還活著就給 1 分


def render(state, width=45):
    """把當下的畫面畫成字元圖。"""
    x, _, theta, _ = state
    height = 9
    canvas = [[" "] * width for _ in range(height)]
    cart_col = int((x + CartPole.x_limit) / (2 * CartPole.x_limit) * (width - 1))
    base_row = height - 1

    # 桿子：從推車往上，依角度往旁邊倒
    for i in range(1, 7):
        row = base_row - i
        col = cart_col + int(round(i * np.tan(theta) * 2.0))
        if 0 <= row < height and 0 <= col < width:
            canvas[row][col] = "|" if abs(theta) < 0.03 else ("/" if theta < 0 else "\\")

    for dc in (-2, -1, 0, 1, 2):
        col = cart_col + dc
        if 0 <= col < width:
            canvas[base_row][col] = "=" if abs(dc) == 2 else "#"

    lines = ["".join(row) for row in canvas]
    lines.append("-" * width)
    return lines


def sparkline(values, width=52, height=9):
    """把學習曲線畫成長條圖。"""
    if len(values) > width:
        # 太多場了，分組取平均，壓縮成 width 根柱子
        chunk = len(values) / width
        values = [float(np.mean(values[int(i * chunk):max(int((i + 1) * chunk), int(i * chunk) + 1)]))
                  for i in range(width)]
    top = max(max(values), 1.0)
    rows = []
    for level in range(height, 0, -1):
        threshold = top * level / height
        rows.append("  " + "".join("█" if v >= threshold else " " for v in values))
    return rows, top


def discounted_returns(rewards, gamma=0.99):
    """把「未來的總分」往回攤到每一步上。

    某個動作好不好，不能只看它當下拿到幾分，
    要看它之後還讓你活了多久 —— 這就是 G_t。
    """
    out = np.zeros(len(rewards))
    running = 0.0
    for i in reversed(range(len(rewards))):
        running = rewards[i] + gamma * running
        out[i] = running
    return out


def run_episode(env, policy, rng, greedy=False, record=False):
    """跑完一場，回傳走過的狀態、選過的動作、拿到的分數。"""
    state = env.reset()
    states, actions, rewards, frames = [], [], [], []
    for _ in range(MAX_STEPS):
        if record:
            frames.append(state.copy())
        logits = policy(Tensor(state.reshape(1, -1)))
        probs = np.exp(logits.log_softmax().data)[0]
        action = int(probs.argmax()) if greedy else int(rng.choice(2, p=probs))
        states.append(state)
        actions.append(action)
        state, reward, done = env.step(action)
        rewards.append(reward)
        if done:
            break
    return np.array(states), np.array(actions), np.array(rewards), frames


def main(seed=0):
    rng = np.random.default_rng(seed)
    env = CartPole(seed=seed)
    policy = Sequential(Linear(4, 64, rng), Tanh(), Linear(64, 2, rng))
    optimizer = Adam(policy.parameters(), lr=0.01)

    print("=" * 62)
    print("自我學習：倒立擺")
    print("=" * 62)
    print("""
  規則：桿子立在推車上，每步只能往左或往右推。
  回饋：撐住一步得 1 分，桿子倒了或推車出界就結束。
  沒有任何示範資料 —— 網路一開始完全不知道該怎麼做。
""")

    # 先看看還沒學之前有多爛，順便留一段畫面待會對照
    before = []
    untrained_frames = []
    for _ in range(20):
        _, _, rewards, frames = run_episode(env, policy, rng, record=True)
        before.append(len(rewards))
        if not untrained_frames:
            untrained_frames = frames
    print(f"  訓練前（隨機亂推）：平均只撐了 {np.mean(before):.1f} 步")
    print(f"  這是它第一場倒下去的樣子（撐了 {len(untrained_frames)} 步）：\n")
    for line in render(untrained_frames[-1]):
        print("  " + line)
    print(f"  桿子已經歪了 {np.degrees(untrained_frames[-1][2]):+.1f}°，出局。\n")

    print("  場次     最近 30 場平均分數")
    scores = []
    episode = 0
    solved_at = None

    while episode < 1500:
        # 一次收集 5 場的經驗再更新一次，梯度比較穩
        batch_states, batch_actions, batch_advantages = [], [], []
        for _ in range(5):
            states, actions, rewards, _ = run_episode(env, policy, rng)
            batch_states.append(states)
            batch_actions.append(actions)
            batch_advantages.append(discounted_returns(rewards))
            scores.append(len(rewards))
            episode += 1

        states = np.concatenate(batch_states)
        actions = np.concatenate(batch_actions)
        advantages = np.concatenate(batch_advantages)
        # 標準化：讓「比平均好的動作」拿到正的權重，比平均差的拿到負的。
        # 這一步就是網路唯一的老師 —— 它只知道「這次比平常好還是差」。
        advantages = (advantages - advantages.mean()) / (advantages.std() + 1e-8)

        log_probs = policy(Tensor(states)).log_softmax()
        onehot = np.zeros((len(actions), 2))
        onehot[np.arange(len(actions)), actions] = 1.0
        chosen = (log_probs * Tensor(onehot)).sum(axis=1)

        # REINFORCE：把「表現好的動作」的機率往上推，表現差的往下壓。
        policy_loss = -(chosen * Tensor(advantages)).mean()
        # 一點點熵獎勵，避免太早鎖死在一種動作上而不再探索。
        entropy = -(log_probs * log_probs.exp()).sum(axis=1).mean()
        loss = policy_loss - 0.01 * entropy

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

        recent = float(np.mean(scores[-30:]))
        if episode % 50 == 0:
            bar = "█" * int(recent / MAX_STEPS * 30)
            print(f"  {episode:5d}     {recent:6.1f}  {bar}")
        if len(scores) >= 30 and recent >= SOLVED:
            solved_at = episode
            break

    print()
    if solved_at:
        print(f"  第 {solved_at} 場學會了：最近 30 場平均 {np.mean(scores[-30:]):.1f} 步（滿分 {MAX_STEPS}）")
    else:
        print(f"  1500 場後平均 {np.mean(scores[-30:]):.1f} 步")

    rows, top = sparkline(scores)
    print("\n學習曲線（每根柱子是一段時間的平均存活步數）：\n")
    for i, row in enumerate(rows):
        label = f"{top * (len(rows) - i) / len(rows):5.0f} " if i % 2 == 0 else "      "
        print(label + row)
    print("      " + "-" * 52)
    print(f"      第 1 場{' ' * 36}第 {len(scores)} 場")

    # 讓學好的策略實際跑一場給你看
    _, _, rewards, frames = run_episode(env, policy, rng, greedy=True, record=True)
    print(f"\n訓練後實際跑一場：撐了 {len(rewards)} 步。以下是其中幾個畫面：\n")
    for step in [0, len(frames) // 3, 2 * len(frames) // 3, len(frames) - 1]:
        print(f"  第 {step + 1} 步   （桿子角度 {np.degrees(frames[step][2]):+.1f}°）")
        for line in render(frames[step]):
            print("  " + line)
        print()

    print("  它沒有看過任何一筆「正確答案」。")
    print("  所有的策略都是從『撐久一點分數就高』這個回饋裡，自己推出來的。")


if __name__ == "__main__":
    main(seed=int(sys.argv[1]) if len(sys.argv) > 1 else 0)
