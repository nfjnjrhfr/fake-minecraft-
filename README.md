# SGPT

一個像 ChatGPT 的 AI 助理 —— 網頁聊天介面 + Node.js 後端，背後接 Anthropic 的
Claude Opus 5。

支援串流回覆、多對話管理、思考過程顯示、網路搜尋、圖片與 PDF 上傳。

---

## 功能

| 功能 | 說明 |
|---|---|
| 串流回覆 | 逐字輸出，隨時可按「停止」中斷 |
| 思考過程 | 可展開查看模型的推理摘要（adaptive thinking） |
| 網路搜尋 | 開啟後由模型自行決定何時搜尋，並列出實際引用的來源 |
| 多對話 | 側欄列出所有對話，第一句話自動命名 |
| 附件 | 圖片（PNG / JPEG / GIF / WebP）與 PDF，可貼上或拖曳 |
| 重新生成 / 編輯 | 從任一輪重跑，或改寫提問後重送 |
| 思考深度 | `low` ~ `max` 五段，權衡品質、速度與成本 |
| 自訂指令 | 每個對話可設定專屬的長期指令 |
| 用量顯示 | 每則回答顯示 input / output token 與快取命中數 |
| 深色模式 | 跟隨系統設定 |

介面全繁體中文，模型會自動配合使用者的語言回答。

---

## 快速開始

需要 Node.js 20.11 以上。

```bash
npm install
cp .env.example .env      # 填入你的 ANTHROPIC_API_KEY
npm run build
npm start
```

打開 http://localhost:3000 就能用了。

開發時用 `npm run dev`（建置後啟動），或另開一個終端跑 `npm run watch` 做增量編譯。

### 取得 API 金鑰

到 [Anthropic Console](https://console.anthropic.com/settings/keys) 建立一把
金鑰，寫進 `.env`：

```
ANTHROPIC_API_KEY=sk-ant-...
```

`.env` 已列在 `.gitignore`，不會被 commit。除了 `ANTHROPIC_API_KEY`，SDK 也接受
`ANTHROPIC_AUTH_TOKEN` 或 `ant auth login` 建立的設定檔。

---

## 設定

所有設定都是環境變數，全部可省略：

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `3000` | HTTP 埠號 |
| `SGPT_MODEL` | `claude-opus-5` | 預設模型 |
| `SGPT_EFFORT` | `high` | 預設思考深度（`low`/`medium`/`high`/`xhigh`/`max`） |
| `SGPT_MAX_TOKENS` | `64000` | 單次回覆上限，會自動壓到模型本身的上限 |
| `SGPT_FALLBACKS` | `1` | 開啟伺服器端拒答備援；設 `0` 關閉 |
| `SGPT_DATA_DIR` | `./data/conversations` | 對話存放目錄 |
| `SGPT_MAX_ATTACHMENT_BYTES` | `12582912` | 單一附件大小上限（12 MB） |

### 可選模型

| 介面名稱 | 模型 ID | 適用情境 |
|---|---|---|
| SGPT-5 | `claude-opus-5` | 最強推理，寫程式與複雜分析 |
| SGPT-5 Balanced | `claude-sonnet-5` | 速度與品質兼顧 |
| SGPT-mini | `claude-haiku-4-5` | 最快最便宜，簡單問答 |

模型能力不同時後端會自動調整請求：Haiku 不支援 adaptive thinking 與 effort，
這兩個參數就不會送出；網路搜尋工具也會依模型自動選用對應的版本。

---

## 架構

```
src/
  server.ts    Express 路由：對話 CRUD + SSE 串流端點
  claude.ts    唯一呼叫 Anthropic API 的地方，對外只吐 SgptEvent
  persona.ts   SGPT 的 system prompt（刻意保持位元穩定，維持 prompt cache）
  store.ts     對話持久化：一個對話一個 JSON 檔，每個 id 序列化寫入
  config.ts    環境變數與模型目錄
  types.ts     共用資料模型
public/
  index.html   介面
  styles.css   樣式（淺色／深色）
  app.js       前端邏輯：SSE 解析、對話管理、附件
  markdown.js  自製 Markdown 渲染器（零外部相依，先跳脫再組 HTML）
```

### 幾個設計決定

**Prompt cache 友善。** system prompt 分成兩塊：SGPT 的人格放在第一塊並打上
`cache_control`，每個對話的自訂指令放在後面。快取是前綴比對，人格只要動一個
位元，所有進行中對話的快取都會失效 —— 所以那段文字刻意不做動態拼接。

**歷史只回放文字。** 我們不保存 thinking block 的簽章，沒有簽章的 thinking
block 回放會被 API 拒絕，所以助理輪次一律以純文字重送。

**先存使用者訊息，再開始生成。** 連線中斷不會弄丟使用者打的字。

**停止 = 掛掉連線。** 前端 abort fetch，伺服器收到 socket close 就 abort 上游
串流，已經產出的部分照樣存檔。

**拒答備援。** Opus 5 可能因安全分類器回 `stop_reason: "refusal"`（HTTP 200）。
預設帶上 `fallbacks: "default"`，讓請求自動轉給備援模型而不是直接死掉；介面上
仍會標示這是一次拒答。

**沒有 CDN。** Markdown 渲染器是自己寫的，全部內容先 `escapeHtml` 再組標籤，
`javascript:` 開頭的連結不會變成 `<a>`。整個前端沒有外部相依，離線可用。

---

## API

| 方法 | 路徑 | 用途 |
|---|---|---|
| `GET` | `/api/config` | 模型目錄與預設設定 |
| `GET` | `/api/conversations` | 對話列表（不含訊息內容） |
| `POST` | `/api/conversations` | 建立對話 |
| `GET` | `/api/conversations/:id` | 取得完整對話 |
| `PATCH` | `/api/conversations/:id` | 改標題或設定 |
| `DELETE` | `/api/conversations/:id` | 刪除對話 |
| `POST` | `/api/conversations/:id/truncate` | 從指定訊息起截斷（重新生成用） |
| `POST` | `/api/conversations/:id/messages` | 送訊息，以 SSE 串流回覆 |
| `GET` | `/api/health` | 健康檢查 |

SSE 事件：`start`、`thinking`、`text`、`tool`、`done`、`error`。

---

## 部署注意事項

這個版本假設**單一使用者、信任的網路環境**（本機或內網）：沒有帳號系統，也
沒有存取控制，任何連得上這個埠的人都能讀寫所有對話。要放上公開網路的話，至少
需要補上驗證、依使用者隔離 `SGPT_DATA_DIR`，以及對 `/api/conversations/:id/messages`
加上速率限制。

對話以純文字 JSON 存在磁碟上，沒有加密。

---

## 授權

MIT
