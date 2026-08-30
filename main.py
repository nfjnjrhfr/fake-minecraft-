"""
四個 Minecraft 方塊 —— Ursina 版

執行方式：
    pip install ursina
    python main.py

操作：
    滑鼠右鍵拖曳 = 旋轉視角
    滾輪        = 拉近／拉遠
    Esc / 關視窗 = 離開
"""

from ursina import *


def mc_color(r, g, b):
    """把 0~255 的 RGB 值轉成 ursina 顏色（相容新舊版本的 ursina）。"""
    if hasattr(color, 'rgb32'):
        return color.rgb32(r, g, b)
    return color.rgb(r, g, b)


# 四個方塊的資料：(名稱, 顏色)
# 想加第五個方塊？在這個清單多寫一行就好，下面的程式會自動幫你排好。
BLOCKS = [
    ('草地方塊 grass', mc_color(106, 170, 64)),
    ('泥土方塊 dirt',  mc_color(134, 96, 67)),
    ('石頭方塊 stone', mc_color(128, 128, 128)),
    ('木頭方塊 wood',  mc_color(160, 128, 78)),
]

BLOCK_SIZE = 1      # 每個方塊的邊長
GAP = 0.1           # 方塊之間留的縫隙


app = Ursina()
window.title = '四個 Minecraft 方塊'
window.color = mc_color(120, 167, 255)   # 天空藍的背景


# --- 把四個方塊排成一列 ---
step = BLOCK_SIZE + GAP                        # 每個方塊之間的間距
start_x = -(len(BLOCKS) - 1) * step / 2        # 讓整排方塊置中

for i, (name, block_color) in enumerate(BLOCKS):
    Entity(
        model='cube',           # 立方體模型
        texture='white_cube',   # ursina 內建材質，有黑色邊框，很像 Minecraft
        color=block_color,      # 用顏色決定它是草地／泥土／石頭／木頭
        position=(start_x + i * step, 0, 0),
        scale=BLOCK_SIZE,
    )
    print(f'第 {i + 1} 個方塊：{name}')


# --- 鏡頭 ---
EditorCamera(rotation=(20, 0, 0))   # 讓你可以用滑鼠右鍵轉來看方塊的側面
camera.z = -8                       # 鏡頭離方塊多遠

app.run()
