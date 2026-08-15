# chatapp — Python 多人通訊系統

一套用 **Python 標準函式庫** 寫成的即時聊天系統，不需要安裝任何套件。
包含伺服器、客戶端與傳輸協定三個部分，支援多人同時上線、多個聊天室與一對一私訊。

## 功能

- 多人同時連線（一條連線一個執行緒）
- 多聊天室：可同時加入多個房間，自由切換
- 一對一私訊
- 新加入者自動收到房間最近 50 則歷史訊息
- 上線／離線／加入／離開的即時通知
- 暱稱唯一性檢查（不分大小寫），支援中文暱稱
- 終端機客戶端，含彩色顯示與斜線指令
- 完整錯誤處理：格式錯誤的訊息只回一則錯誤，不會拖垮伺服器

## 快速開始

需要 Python 3.9 以上（開發環境為 3.11）。

**第一個終端機 — 啟動伺服器：**

```bash
python3 -m chatapp server --port 5000
```

**其他終端機 — 連線進去聊天：**

```bash
python3 -m chatapp client --port 5000 --nick amy
python3 -m chatapp client --port 5000 --nick 小明
```

若要讓別台電腦連進來，伺服器改用 `--host 0.0.0.0`，客戶端則用 `--host <伺服器IP>`。

## 客戶端指令

| 指令 | 說明 |
| --- | --- |
| `/join <房間>` | 加入並切換到某個房間 |
| `/leave [房間]` | 離開房間（預設為目前房間） |
| `/rooms` | 列出所有房間與人數 |
| `/users [房間]` | 列出房間內的成員 |
| `/msg <暱稱> <訊息>` | 傳私訊（別名 `/w`、`/tell`） |
| `/me <動作>` | 動作訊息，例如 `/me 在喝咖啡` |
| `/nick` | 顯示自己的暱稱與目前房間 |
| `/help` | 顯示說明 |
| `/quit` | 離開聊天室 |

不是以 `/` 開頭的輸入，都會直接送到目前所在的房間。

## 專案結構

```
chatapp/
  protocol.py   傳輸協定：編碼、解碼、串流切行
  server.py     聊天伺服器：連線管理、房間、廣播
  client.py     終端機客戶端：接收執行緒 + 輸入迴圈
  __main__.py   進入點：python -m chatapp <server|client>
tests/
  test_protocol.py   協定單元測試
  test_server.py     伺服器整合測試（真的開 socket 連線）
```

## 傳輸協定

訊息以「一行一個 JSON 物件」（NDJSON）在 TCP 上傳輸，每個物件都有 `type` 欄位：

```json
{"type": "chat", "room": "lobby", "sender": "amy", "text": "大家好", "ts": 1755230680.5}
```

用換行當分隔符，不需要長度前綴，用 `telnet` 或 `nc` 也能手動測試：

```bash
printf '{"type":"login","nick":"tester"}\n{"type":"chat","room":"lobby","text":"hi"}\n' | nc 127.0.0.1 5000
```

**客戶端 → 伺服器**：`login`、`chat`、`private`、`join`、`leave`、`rooms`、`users`、`quit`

**伺服器 → 客戶端**：`welcome`、`chat`、`private`、`system`、`error`、`room_list`、`user_list`、`history`、`bye`

TCP 不保證一次 `recv` 剛好對應一則訊息，所以 `protocol.LineReader` 會自行維護緩衝區，
處理黏包（多則訊息擠在一次）與拆包（一則訊息被切成好幾次）。

## 執行測試

```bash
python3 -m unittest discover -s tests -v
```

共 35 個測試，涵蓋協定編解碼、串流切行、登入驗證、廣播隔離、私訊、
房間管理、歷史紀錄、斷線清理與多人連線。

## 實作備註

- 所有共享狀態（暱稱表、房間表）都由一把 `RLock` 保護。
- 每條連線各有自己的寫入鎖，避免兩個執行緒同時 `sendall` 造成訊息交錯。
- 廣播時若某個對象已斷線，只會略過它，不會影響其他人收訊。
- 單行訊息上限 64 KB、單則聊天內容上限 2000 字，避免惡意端點灌爆記憶體。
- 沒有人的房間會自動清除（`lobby` 永遠保留）。
