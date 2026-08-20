# SnapMind 拍讀 AI 📸

一個真的能跑的 AI 助手：**拍照 → 完整讀出畫面上的訊息 → 接著跟它對話**，
同一個介面裡既是生產力工具（擷取、待辦、行程、表格、翻譯、會議紀錄），也是娛樂項目（銳評、故事、猜謎、文字冒險）。

後端用 [Anthropic Claude API](https://platform.claude.com/) 的 `claude-opus-5`（vision + streaming + structured outputs），
前端是零建置的純 HTML/CSS/JS，手機開瀏覽器就能直接拍照使用。

---

## 30 秒跑起來

```bash
npm install
cp .env.example .env        # 填入 ANTHROPIC_API_KEY
npm start                   # → http://localhost:3000
```

沒有把金鑰放進 `.env` 也可以：開網頁後點右上角 ⚙️，把金鑰貼進去（只存在你這台裝置的 localStorage）。

> 想在手機上拍照，瀏覽器要求 HTTPS 或 localhost 才會開放相機。
> 手機連桌機時可以用 `ssh -R`、`cloudflared tunnel`、`ngrok http 3000` 之類的工具轉成 https 網址；
> 若相機無法開啟，程式會自動退回系統相機（`<input capture>`），功能不受影響。

## 也能在終端機用

```bash
npm run ask -- 收據.jpg "總共多少錢？"
npm run ask -- --mode ocr 白板照片.png
npm run ask -- --mode roast 自拍.jpg
```

## 測試

```bash
npm test
```

10 個整合測試會啟動一個假的 Anthropic API（`test/mock-anthropic.js`），驗證 SSE 串流、對話歷史、
結構化擷取、圖片格式檢查與錯誤處理——**不需要真的金鑰、不會花到錢**。

---

## 功能

### 📷 拍照識別完整訊息
- 網頁內建相機（可切換前後鏡頭）、相簿選檔、拖曳、Ctrl+V 貼上，一次最多 6 張。
- 圖片在瀏覽器端先縮到 1568px、轉 JPEG 再上傳，省流量也省 token。
- 系統提示要求 **逐字、不省略、不臆測**：聊天截圖要逐則列出發話者與時間，看不清楚的字標 `[?]`，
  最後附「辨識備註」說明哪裡不確定。

### ⚡ 結構化擷取（`/api/extract`）
用 structured outputs（`output_config.format` + JSON Schema）把照片轉成固定欄位的資料：
逐字全文、重點、關鍵欄位、待辦、行程、表格、聯絡資訊、無法辨識處。擷取完可以一鍵：

| 匯出 | 用途 |
| --- | --- |
| 複製 / 下載 `.md` | 貼到 Notion、Obsidian |
| 下載 `.csv` | 發票、報表直接進 Excel（含 BOM，中文不亂碼） |
| 下載 `.ics` | 行程直接匯入 Google 日曆 / Apple 行事曆 |
| 存成筆記 | 留在本機筆記本，可搜尋、可整包匯出 |

### 💬 對話
逐字串流回應（SSE）、可顯示思考摘要、隨時中斷、記得前後文。
為了控制成本，只有最近 3 輪的圖片會保留原圖，更早的圖片改成文字佔位；歷史超過 24 則會自動裁切。

### 🧰 生產力模式
`完整訊息擷取`、`待辦與行程`、`表格與收據`、`翻譯`、`摘要與紀錄`、`講解教學`

### 🎮 娛樂模式
`銳評吐槽`、`照片說故事`、`猜謎挑戰`、`角色扮演`（文字冒險，照片會變成場景）

---

## 專案結構

```
server/
  index.js          Express 進入點、靜態檔案、/api/health、/api/modes
  config.js         模型、上限、TTL 等設定（都可用環境變數覆寫）
  claude.js         Anthropic client、金鑰來源、錯誤訊息中文化
  prompts.js        11 種模式的系統提示與預設任務
  schema.js         結構化擷取的 JSON Schema
  images.js         data URL 驗證（格式、大小、張數）
  sessions.js       記憶體對話存放、歷史裁切、舊圖片降級
  routes/chat.js    SSE 串流對話
  routes/extract.js 結構化擷取
public/
  index.html        單頁介面
  styles.css        深色／淺色自動切換、手機優先
  app.js            相機、縮圖、串流解析、匯出、筆記本
  markdown.js       自製輕量 Markdown 渲染（含 HTML 跳脫，不依賴 CDN）
scripts/cli.js      終端機版
test/               整合測試 + 假 API
```

## API

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `GET` | `/api/health` | 模型、金鑰狀態 |
| `GET` | `/api/modes` | 模式清單 |
| `POST` | `/api/chat` | 對話，回 SSE：`meta` / `thinking` / `delta` / `done` / `error` |
| `POST` | `/api/extract` | 圖片 → 結構化 JSON |
| `POST` | `/api/session/reset` | 清除該 session 的歷史 |

## 安全性與隱私

- 金鑰預設放伺服器端；瀏覽器端金鑰只存在該裝置，經由本機伺服器轉呼叫 API。
  要部署到公開網路時，設定 `ALLOW_CLIENT_KEY=false` 只用伺服器金鑰。
- 對話存在記憶體，重開就消失（預設 3 小時未使用即回收）；筆記存在瀏覽器 localStorage，不會上傳。
- 模型回覆一律經過自製 Markdown 渲染器跳脫 HTML，不會執行圖片或回覆裡的內容。
