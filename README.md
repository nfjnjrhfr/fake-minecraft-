# fake-minecraft-

用 Python + [Ursina](https://www.ursinaengine.org/) 引擎做的 Minecraft 小練習。

## 目前的內容

`main.py` — 在畫面上畫出四個方塊：草地、泥土、石頭、木頭。

## 怎麼跑

```bash
pip install -r requirements.txt
python main.py
```

## 操作

| 動作 | 按鍵 |
| --- | --- |
| 旋轉視角 | 滑鼠右鍵拖曳 |
| 拉近／拉遠 | 滾輪 |
| 離開 | 關掉視窗 |

## 想改東西？

打開 `main.py`，最上面有一個 `BLOCKS` 清單：

```python
BLOCKS = [
    ('草地方塊 grass', mc_color(106, 170, 64)),
    ...
]
```

在裡面多加一行，就會多出一個方塊，程式會自動幫你重新排列置中。
