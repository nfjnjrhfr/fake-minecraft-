"""Fake Minecraft - 一個文字版的挖礦打怪小遊戲。

核心規則來自最初的三行虛擬碼:

    Variable (hp)
    die = (hp == 0)
    if hp <= 0: print("Play one more game?")

原本寫成 die = (hp = 0) 是「賦值」而不是「比較」, 那會每次都把血量歸零。
另外傷害可能一次扣超過剩餘血量 (hp 變成負數), 所以死亡條件用 hp <= 0。
"""

import random

MAX_HP = 20
HEART = "♥"


class Player:
    """玩家: hp 就是這個遊戲的核心變數。"""

    def __init__(self, name="Steve", hp=MAX_HP):
        self.name = name
        self.hp = hp
        self.max_hp = hp
        self.food = 3
        self.score = 0

    @property
    def die(self):
        """死亡判定。血量歸零 (或變成負數) 就算死。"""
        return self.hp <= 0

    def hurt(self, amount):
        """扣血, 但不會低於 0, 免得顯示出 -3 顆愛心。"""
        self.hp = max(0, self.hp - amount)
        return amount

    def heal(self, amount):
        """補血, 但不會超過血量上限。"""
        healed = min(amount, self.max_hp - self.hp)
        self.hp += healed
        return healed

    def health_bar(self):
        filled = HEART * self.hp
        empty = "·" * (self.max_hp - self.hp)
        return f"{filled}{empty} ({self.hp}/{self.max_hp})"


class Monster:
    def __init__(self, name, hp, damage):
        self.name = name
        self.hp = hp
        self.damage = damage

    @property
    def die(self):
        return self.hp <= 0


MONSTERS = [
    ("殭屍 Zombie", 8, 3),
    ("骷髏 Skeleton", 6, 4),
    ("蜘蛛 Spider", 5, 2),
    ("苦力怕 Creeper", 4, 9),  # 傷害很痛, 但血少
]


def spawn_monster(level):
    """關卡越高, 怪物越強。"""
    name, hp, damage = random.choice(MONSTERS)
    hp += level - 1
    return Monster(name, hp, damage)


def ask(prompt, choices):
    """讀取輸入, 直到玩家給出合法選項為止。

    按 Ctrl+C / Ctrl+D 直接離開, 當作選了最後一個選項 (通常是 n 或 r)。
    """
    while True:
        try:
            answer = input(prompt).strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return choices[-1]
        if answer in choices:
            return answer
        print(f"  請輸入 {' / '.join(choices)}")


def battle(player, monster, level):
    """一場戰鬥。回傳 True 代表玩家活著打贏。"""
    print(f"\n--- 第 {level} 關 ---")
    print(f"一隻 {monster.name} 出現了! (HP {monster.hp}, 攻擊 {monster.damage})")

    while not monster.die and not player.die:
        print(f"\n{player.name}: {player.health_bar()}   食物 x{player.food}")
        action = ask("  [a] 攻擊  [e] 吃東西  [r] 逃跑 > ", ["a", "e", "r"])

        if action == "a":
            hit = random.randint(2, 5)
            monster.hp -= hit
            print(f"  你揮出鑽石劍, 造成 {hit} 點傷害!")
            if monster.die:
                player.score += level * 10
                print(f"  {monster.name} 倒下了! (+{level * 10} 分)")
                break

        elif action == "e":
            if player.food <= 0:
                print("  背包空了, 沒東西可以吃。")
            else:
                player.food -= 1
                healed = player.heal(random.randint(4, 7))
                print(f"  你吃了一塊烤豬排, 恢復 {healed} 點血。")

        elif action == "r":
            if random.random() < 0.5:
                print("  你成功逃走了, 但這一關不計分。")
                return True
            print("  逃跑失敗! 怪物趁機攻擊你。")

        # 換怪物出手
        damage = random.randint(1, monster.damage)
        player.hurt(damage)
        print(f"  {monster.name} 打了你 {damage} 點傷害。")

    return not player.die


def play_once():
    """玩一整場, 回傳這場的分數。"""
    player = Player()
    level = 1

    print("\n=== Fake Minecraft ===")
    print("撐過越多關分數越高。血量歸零就 Game Over。")

    while not player.die:
        if not battle(player, spawn_monster(level), level):
            break
        level += 1
        if random.random() < 0.4:
            player.food += 1
            print("  你在箱子裡找到一塊食物! (食物 +1)")

    # 這裡就是原始碼那個 if: hp 歸零 -> 印出訊息
    if player.die:
        print(f"\n{player.name}: {player.health_bar()}")
        print("你死了。You died!")

    print(f"最後分數: {player.score} (撐到第 {level} 關)")
    return player.score


def main():
    best = 0
    while True:
        best = max(best, play_once())
        print(f"最高分: {best}")
        if ask("\nPlay one more game? 再玩一局嗎? [y/n] > ", ["y", "n"]) == "n":
            break
    print("下次見!")


if __name__ == "__main__":
    main()
