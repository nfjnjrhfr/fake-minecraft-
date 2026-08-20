"""Fake Minecraft - 一個超小型的文字生存遊戲。

玩法：撐過 10 個夜晚就贏，hp 掉到 0 以下就死。
"""

import random

MAX_HP = 20
NIGHTS_TO_WIN = 10

MOBS = [
    ("殭屍 Zombie", 3),
    ("骷髏 Skeleton", 4),
    ("蜘蛛 Spider", 2),
    ("苦力怕 Creeper", 7),
]


def take_damage(hp, amount):
    """扣血，並回傳 (新的 hp, 是否死亡)。"""
    hp = hp - amount
    died = hp <= 0          # 你的 die=(hp=0)，修正成比較而且涵蓋負數
    if died:
        hp = 0              # 顯示用：血條不要出現負數
    return hp, died


def heal(hp, amount):
    """回血，但不能超過血量上限。"""
    return min(MAX_HP, hp + amount)


def hp_bar(hp):
    """把 hp 畫成愛心血條，例如 ♥♥♥♥♥♡♡♡♡♡ 10/20"""
    hearts = round(hp / MAX_HP * 10)
    return "♥" * hearts + "♡" * (10 - hearts) + f" {hp}/{MAX_HP}"


def ask(prompt, choices):
    """一直問到玩家輸入合法選項為止。"""
    while True:
        answer = input(prompt).strip().lower()
        if answer in choices:
            return answer
        print(f"  請輸入 {' / '.join(choices)}")


def night(hp, n):
    """過一個夜晚，回傳 (新的 hp, 是否死亡)。"""
    mob, power = random.choice(MOBS)
    print(f"\n=== 第 {n} 夜 ===  {hp_bar(hp)}")
    print(f"天黑了，一隻{mob}朝你走過來。")

    action = ask("  要 [f]戰鬥 還是 [r]逃跑？ ", ["f", "r"])

    if action == "f":
        if random.random() < 0.6:
            print(f"  你打敗了{mob}！掉落了食物，回復 2 點血。")
            return heal(hp, 2), False
        damage = power
        print(f"  {mob}打中你，受到 {damage} 點傷害。")
    else:
        if random.random() < 0.5:
            print("  你成功逃回小屋，平安度過一夜。")
            return hp, False
        damage = max(1, power // 2)
        print(f"  逃跑失敗，被{mob}追上，受到 {damage} 點傷害。")

    return take_damage(hp, damage)


def play_one_game():
    """玩一局。贏了回傳 True，死了回傳 False。"""
    hp = MAX_HP
    print("\n你在一個陌生的世界醒來，手上只有一把木劍。")
    print(f"撐過 {NIGHTS_TO_WIN} 個夜晚就能回家。")

    for n in range(1, NIGHTS_TO_WIN + 1):
        hp, died = night(hp, n)
        if died:
            print(f"\n  {hp_bar(hp)}")
            print(f"  你死了。你撐了 {n} 個夜晚。")
            return False

    print(f"\n太陽升起，你活下來了！最終血量 {hp_bar(hp)}")
    return True


def main():
    print("=" * 40)
    print("       Fake Minecraft")
    print("=" * 40)

    wins = 0
    games = 0

    while True:
        games += 1
        if play_one_game():
            wins += 1

        print(f"\n戰績：{games} 局裡贏了 {wins} 局。")
        # 這就是你原本的 print("play one more game?")
        if ask("再玩一局嗎？ [y/n] ", ["y", "n"]) == "n":
            break

    print("\n下次見！")


if __name__ == "__main__":
    main()
