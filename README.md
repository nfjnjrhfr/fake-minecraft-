# binary-ai

一個聊天程式：你打的每一句話，在送給 AI 之前**真的**會被轉換成二進位（0 和 1），
AI 收到的就是那串 0101，再由 AI 解碼後回答你。

轉換是真的、不是裝飾，但**過程不會顯示給使用者**——你看到的就是一般的對話。

```
you> 你好，今天天氣如何？

ai> 我沒辦法查即時天氣，不過你可以告訴我你在哪個城市……
```

實際送出去的內容長這樣（預設看不到）：

```
11100100 10111101 10100000 11100101 10100101 10111101 11101111 ...
```

## 運作方式

1. `binary_ai/codec.py` — 把文字用 UTF-8 編碼，每個 byte 轉成 8 位元的 0/1 字串。
   完全可逆，中文、日文、emoji 都沒問題（`decode(encode(x)) == x`）。
2. `binary_ai/chat.py` — 把那串二進位當作訊息內容送給 Claude（模型 `claude-opus-5`）。
   system prompt 告訴模型：收到的訊息是 UTF-8 二進位，請先解碼再正常回答。
   對話歷史中保存的使用者訊息也是二進位版本。
3. `binary_ai/cli.py` — 終端機介面。只顯示你的輸入和 AI 的回覆，不顯示位元。

模型回覆是一般文字（不是二進位），並且會用你原本使用的語言回答。

## 安裝

```bash
pip install -e ".[dev]"
```

設定金鑰（擇一）：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# 或使用 Anthropic CLI 登入：ant auth login
```

## 使用

```bash
binary-ai              # 或 python -m binary_ai.cli
```

指令：

| 指令 | 說明 |
| --- | --- |
| `/help` | 顯示說明 |
| `/reset` | 清空對話重新開始 |
| `/quit` | 離開（Ctrl-D 也可以） |

選項：

| 選項 | 預設 | 說明 |
| --- | --- | --- |
| `--model` | `claude-opus-5` | 使用的模型 |
| `--effort` | `medium` | 思考程度：`low` / `medium` / `high` / `xhigh` / `max` |
| `--max-tokens` | `64000` | 回覆長度上限 |
| `--debug` | 關閉 | 把實際送出的位元印到 stderr（僅供驗證用） |

想親眼確認訊息真的變成 0101，就加上 `--debug`：

```bash
binary-ai --debug
```

## 當程式庫使用

```python
from binary_ai import BinaryChat, encode, decode

encode("Hi")                 # '01001000 01101001'
decode("01001000 01101001")  # 'Hi'

chat = BinaryChat()
for chunk in chat.send("用一句話解釋二進位"):
    print(chunk, end="", flush=True)
```

## 測試

```bash
pytest
```

## 備註

請求預設帶上 server-side fallback（beta `server-side-fallback-2026-07-01`），
讓少數被安全分類器拒絕的請求可以自動改由其他模型處理；若該 beta 在你的組織尚未開通，
程式會自動改用一般端點，不會中斷對話。
