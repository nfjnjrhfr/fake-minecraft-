"""Fake Minecraft — 一個可以在終端機玩的小遊戲。

原本的想法（虛擬碼）是這樣：

    Variable (hp)
    die = (hp = 0)
    If hp = 0 then print ("play one more game?")

這裡把它變成真的程式，並修掉兩個問題：
  1. `hp = 0` 是「把 hp 設成 0」，不是「檢查 hp 是不是 0」，要用 `==`。
  2. 傷害可能一次扣超過剩下的血，hp 會變負的，所以判定要用 `<= 0`。
     （或是像下面 take_damage() 一樣把 hp 夾在 0 以下不再往下掉。）
"""

import random

MAX_HP = 20          # 跟 Minecraft 一樣：10 顆心 = 20 點血
START_HUNGER = 20


class Player:
    """玩家：有 hp、飢餓值和背包。"""

    def __init__(self):
        self.hp = MAX_HP
        self.hunger = START_HUNGER
        self.inventory = {"wood": 0, "stone": 0, "diamond": 0, "food": 2}
        self.score = 0

    # --- hp 相關 ---------------------------------------------------
    @property
    def die(self):
        """die = (hp == 0)  ← 這就是原本那行，修成比較而不是指派。"""
        return self.hp <= 0

    def take_damage(self, amount):
        self.hp = max(0, self.hp - amount)   # 不讓血變負數
        return amount

    def heal(self, amount):
        healed = min(amount, MAX_HP - self.hp)
        self.hp += healed
        return healed

    # --- 顯示 ------------------------------------------------------
    def hearts(self):
        full = self.hp // 2
        half = self.hp % 2
        empty = (MAX_HP - self.hp) // 2
        return "♥" * full + ("♡" if half else "") + "·" * empty

    def status(self):
        bag = "  ".join(f"{k}:{v}" for k, v in self.inventory.items())
        return (f"HP {self.hp}/{MAX_HP} {self.hearts()}   "
                f"飢餓 {self.hunger}/{START_HUNGER}   分數 {self.score}\n"
                f"背包: {bag}")


MOBS = [
    ("殭屍 Zombie", 3),
    ("蜘蛛 Spider", 2),
    ("骷髏 Skeleton", 4),
    ("苦力怕 Creeper", 7),
]


def mine(player):
    """挖礦：拿到資源，但有機率被砸到或遇到怪。"""
    block, amount = random.choice([
        ("wood", 2), ("wood", 3), ("stone", 2), ("stone", 4), ("diamond", 1),
    ])
    player.inventory[block] += amount
    player.score += amount * (10 if block == "diamond" else 1)
    print(f"⛏  你挖到了 {amount} 個 {block}！")

    if random.random() < 0.35:
        mob, dmg = random.choice(MOBS)
        print(f"👾 一隻 {mob} 從黑暗裡跳出來，打了你 {dmg} 點傷害！")
        player.take_damage(dmg)
    return True


def fight(player):
    """打怪：贏了加分，輸了扣血。"""
    mob, dmg = random.choice(MOBS)
    print(f"⚔  你遇到了 {mob}，開打！")
    if random.random() < 0.6:
        player.score += dmg * 5
        print(f"🏆 你打贏了 {mob}，得到 {dmg * 5} 分。")
    else:
        player.take_damage(dmg)
        print(f"💥 你被 {mob} 打中，扣 {dmg} 點血。")
    return True


def eat(player):
    """吃東西：補血，但要有食物。"""
    if player.inventory["food"] <= 0:
        print("🍖 你的背包裡沒有食物了。")
        return False
    player.inventory["food"] -= 1
    healed = player.heal(6)
    player.hunger = min(START_HUNGER, player.hunger + 5)
    print(f"🍗 你吃了一塊烤豬排，回復 {healed} 點血。" if healed
          else "🍗 你吃飽了，但血是滿的。")
    return True


def rest(player):
    """睡覺：回血，但飢餓掉比較多。"""
    healed = player.heal(4)
    print(f"🛏  你睡了一覺，回復 {healed} 點血。" if healed
          else "🛏  你睡了一覺，血本來就是滿的。")
    player.hunger -= 2
    return True


ACTIONS = {
    "1": ("挖礦 mine", mine),
    "2": ("打怪 fight", fight),
    "3": ("吃東西 eat", eat),
    "4": ("睡覺 rest", rest),
}


def tick_hunger(player):
    """每回合消耗飢餓值；餓到 0 就開始扣血。"""
    player.hunger = max(0, player.hunger - 1)
    if player.hunger == 0:
        player.take_damage(1)
        print("🥴 你餓得受不了，扣 1 點血。")


def play_round():
    """玩一局，回到主迴圈時回傳這局的分數。"""
    player = Player()
    print("\n=== 新的世界產生了！輸入數字選擇動作，q 離開 ===")

    while not player.die:                 # ← 死了就跳出，靠的就是那個 die
        print("\n" + player.status())
        print("  " + "   ".join(f"[{k}] {name}" for k, (name, _) in ACTIONS.items())
              + "   [q] 離開")
        choice = input("> ").strip().lower()

        if choice == "q":
            print("👋 你離開了這個世界。")
            return player.score
        if choice not in ACTIONS:
            print("❓ 沒有這個選項。")
            continue

        ACTIONS[choice][1](player)
        tick_hunger(player)

    # if hp == 0 then ...  ← 原本那行的位置
    print("\n" + "=" * 40)
    print(f"☠️  你死了！ You died!   最後分數：{player.score}")
    print("=" * 40)
    return player.score


def ask_play_again():
    """If hp == 0 then print ('play one more game?')"""
    while True:
        answer = input("再玩一場嗎？ Play one more game? (y/n) ").strip().lower()
        if answer in ("y", "yes", "是", ""):
            return True
        if answer in ("n", "no", "否"):
            return False
        print("請輸入 y 或 n。")


def main():
    print("=" * 40)
    print("        FAKE MINECRAFT  假·當個創世神")
    print("=" * 40)

    best = 0
    games = 0
    while True:
        score = play_round()
        games += 1
        best = max(best, score)
        print(f"最高分：{best}（第 {games} 場）")
        if not ask_play_again():
            print("下次見！ See you next time.")
            break


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\n遊戲結束。")
