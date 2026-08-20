# fake-minecraft-

一個用 Python 寫的終端機小遊戲：假·當個創世神。

## 玩法

```bash
python3 game.py
```

每個回合選一個動作：

| 選項 | 動作 | 效果 |
|------|------|------|
| 1 | 挖礦 mine | 拿到 wood / stone / diamond，有 35% 機率被怪打 |
| 2 | 打怪 fight | 60% 贏了加分，40% 輸了扣血 |
| 3 | 吃東西 eat | 消耗一份食物，回 6 點血 |
| 4 | 睡覺 rest | 回 4 點血，但多消耗飢餓值 |
| q | 離開 | 結束這一局 |

每回合飢餓值 -1，餓到 0 之後每回合再扣 1 點血。
血歸零就死，然後會問你「再玩一場嗎？ Play one more game?」。

## hp 的邏輯

原本的想法是這樣寫的：

```
Variable (hp)
die = (hp = 0)
If hp = 0 then print ("play one more game?")
```

放進遊戲時修了兩個地方：

1. `hp = 0` 是把 hp **設成** 0，不是**檢查** hp 是不是 0 —— 要用 `==`。
2. 一次受到的傷害可能超過剩下的血，hp 會變成負數，`hp == 0` 就永遠不成立。
   所以判定寫成 `hp <= 0`，同時在 `take_damage()` 裡用 `max(0, ...)` 把血夾在 0。

實際的程式（`game.py`）：

```python
def take_damage(self, amount):
    self.hp = max(0, self.hp - amount)   # 不讓血變負數

@property
def die(self):
    return self.hp <= 0                  # die = (hp == 0)
```

主迴圈就靠這個 `die` 判斷要不要結束，死掉之後才問「再玩一場嗎？」。

## 測試

```bash
python3 test_game.py
```
