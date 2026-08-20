import { Router } from 'express';
import { MODEL, STREAM_MAX_TOKENS } from '../config.js';
import { describeError, getClient } from '../claude.js';
import { toImageBlocks } from '../images.js';
import { buildSystem, defaultTask, getMode } from '../prompts.js';
import { appendMessage, getSession, historyForRequest, resetSession } from '../sessions.js';

export const chatRouter = Router();

function sse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** 串流對話：文字 + 圖片 → SSE（meta / thinking / delta / done / error） */
chatRouter.post('/chat', async (req, res) => {
  const {
    sessionId,
    mode = 'chat',
    text = '',
    images = [],
    today,
    userNote,
  } = req.body ?? {};

  let client;
  let imageBlocks;
  let session;
  try {
    client = getClient(req.get('x-user-api-key'));
    imageBlocks = toImageBlocks(images);
    if (!imageBlocks.length && !String(text).trim()) {
      const err = new Error('請輸入文字或至少上傳一張圖片');
      err.status = 400;
      throw err;
    }
    session = getSession(sessionId, mode);
  } catch (err) {
    const { status, message } = err.status ? { status: err.status, message: err.message } : describeError(err);
    return res.status(status).json({ error: message });
  }

  const prompt = String(text).trim() || defaultTask(mode);
  const userContent = [...imageBlocks, { type: 'text', text: prompt }];
  appendMessage(session, { role: 'user', content: userContent });

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  sse(res, 'meta', { sessionId: session.id, mode, model: MODEL, images: imageBlocks.length });

  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  let stream;
  let finished = false;
  // 使用者關掉分頁 / 按停止 → 中止上游請求，不要繼續燒 token
  const onClose = () => { if (!finished) stream?.abort?.(); };
  res.on('close', onClose);

  try {
    stream = client.messages.stream({
      model: MODEL,
      max_tokens: STREAM_MAX_TOKENS,
      system: buildSystem(mode, { today, userNote }),
      messages: historyForRequest(session),
      // Claude Opus 5 預設就是 adaptive thinking；display 設 summarized 才看得到思考摘要
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: getMode(mode).effort },
    });

    let answer = '';
    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'text_delta') {
        answer += event.delta.text;
        sse(res, 'delta', { text: event.delta.text });
      } else if (event.delta.type === 'thinking_delta') {
        sse(res, 'thinking', { text: event.delta.thinking });
      }
    }

    const final = await stream.finalMessage();
    if (!answer) {
      answer = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    appendMessage(session, { role: 'assistant', content: [{ type: 'text', text: answer }] });

    sse(res, 'done', {
      sessionId: session.id,
      stop_reason: final.stop_reason,
      stop_details: final.stop_details ?? null,
      usage: {
        input: final.usage?.input_tokens ?? 0,
        output: final.usage?.output_tokens ?? 0,
        cache_read: final.usage?.cache_read_input_tokens ?? 0,
      },
    });
  } catch (err) {
    // 使用者中途離開造成的中斷不算錯誤
    if (!res.writableEnded && err?.name !== 'APIUserAbortError') {
      const { message } = describeError(err);
      // 這一輪失敗，把剛加進去的使用者訊息移除，避免歷史殘留半截對話
      session.messages.pop();
      sse(res, 'error', { message });
    }
  } finally {
    finished = true;
    clearInterval(heartbeat);
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
});

chatRouter.post('/session/reset', (req, res) => {
  const session = resetSession(req.body?.sessionId);
  res.json({ sessionId: session.id });
});
