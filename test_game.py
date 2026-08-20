"""hp 邏輯的小測試：python3 test_game.py"""

import game


def check(name, cond):
    print(("PASS  " if cond else "FAIL  ") + name)
    assert cond, name


p = game.Player()
check("一開始滿血", p.hp == game.MAX_HP)
check("一開始沒死", p.die is False)

p.take_damage(game.MAX_HP)
check("扣完血 hp 是 0", p.hp == 0)
check("hp == 0 就是死了", p.die is True)

p2 = game.Player()
p2.take_damage(999)
check("扣爆也不會變負數", p2.hp == 0)
check("扣爆一樣算死", p2.die is True)

p3 = game.Player()
p3.take_damage(5)
check("補血補得回來", p3.heal(3) == 3 and p3.hp == game.MAX_HP - 2)
check("補血不會超過上限", p3.heal(100) == 2 and p3.hp == game.MAX_HP)

p4 = game.Player()
p4.inventory["food"] = 0
check("沒食物就不能吃", game.eat(p4) is False)

p5 = game.Player()
p5.hunger = 2
game.tick_hunger(p5)
check("還有飢餓值時不扣血", p5.hunger == 1 and p5.hp == game.MAX_HP)
game.tick_hunger(p5)
check("飢餓歸零就扣血", p5.hunger == 0 and p5.hp == game.MAX_HP - 1)
game.tick_hunger(p5)
check("飢餓 0 時每回合再扣 1 血", p5.hp == game.MAX_HP - 2)

print("\n全部通過 ✅")
