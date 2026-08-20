import { Router } from 'express';
import { MAX_TOKENS, MODEL } from '../config.js';
import { describeError, getClient } from '../claude.js';
import { toImageBlocks } from '../images.js';
import { EXTRACTION_SCHEMA } from '../schema.js';

export const extractRouter = Router();

const SYSTEM = `你是文件擷取引擎。把使用者提供的圖片內容完整、忠實地轉成結構化資料。

鐵則：
- full_text 必須是畫面上所有文字的完整逐字內容，不可省略、不可摘要、不可改寫，保留原本的順序與換行。
- 聊天截圖在 full_text 中以「發話者：內容（時間）」逐則列出，一則都不能漏。
- 看不清楚的字用 [?]；把這些位置也列進 unreadable。
- 沒有的欄位給空字串或空陣列，絕對不要編造內容。
- 日期一律寫成 YYYY-MM-DD；相對日期（例如「下週三」）以使用者提供的今天日期換算。
- 中文一律使用繁體中文。`;

/** 拍照 → 結構化資料（可直接匯出 CSV / ICS / Markdown）。 */
extractRouter.post('/extract', async (req, res) => {
  const { images = [], text = '', today } = req.body ?? {};
  try {
    const client = getClient(req.get('x-user-api-key'));
    const imageBlocks = toImageBlocks(images);
    if (!imageBlocks.length) {
      return res.status(400).json({ error: '請至少上傳一張圖片' });
    }

    const instruction = [
      today ? `今天是 ${today}。` : '',
      String(text).trim() || '請完整擷取這些圖片中的所有訊息。',
    ].filter(Boolean).join('\n');

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: [...imageBlocks, { type: 'text', text: instruction }] }],
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
      },
    });

    if (response.stop_reason === 'refusal') {
      return res.status(422).json({
        error: '這張圖片的內容無法處理。',
        details: response.stop_details ?? null,
      });
    }

    const raw = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: '模型回傳的資料不是合法 JSON，請再試一次。', raw });
    }

    res.json({
      data,
      usage: {
        input: response.usage?.input_tokens ?? 0,
        output: response.usage?.output_tokens ?? 0,
      },
    });
  } catch (err) {
    const { status, message } = err.status && err.name === 'ImageError'
      ? { status: err.status, message: err.message }
      : describeError(err);
    res.status(status).json({ error: message });
  }
});
