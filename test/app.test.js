import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { startMockApi } from './mock-anthropic.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let mock;
let base;
let server;
let received;

before(async () => {
  mock = await startMockApi({
    text: '測試回覆：畫面上寫著「營業時間 09:00-18:00」。',
    json: {
      doc_type: '公告', languages: ['中文'], title: '營業時間公告',
      full_text: '營業時間 09:00-18:00', summary: ['每天 9 點到 18 點'],
      key_values: [{ label: '營業時間', value: '09:00-18:00' }],
      action_items: [], events: [], tables: [], contacts: [], unreadable: [],
    },
  });
  received = mock.received;
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

  const { app } = await import('../server/index.js');
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  mock?.server.close();
});

async function readSse(res) {
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const ev = frame.split('\n').find((l) => l.startsWith('event: '));
      const data = frame.split('\n').find((l) => l.startsWith('data: '));
      if (ev && data) events.push({ event: ev.slice(7).trim(), data: JSON.parse(data.slice(6)) });
    }
  }
  return events;
}

test('/api/health 回報模型與金鑰狀態', async () => {
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.keyReady, true);
  assert.ok(health.model);
});

test('/api/modes 至少包含生產力與娛樂模式', async () => {
  const { modes } = await fetch(`${base}/api/modes`).then((r) => r.json());
  assert.ok(modes.some((m) => m.group === 'work'));
  assert.ok(modes.some((m) => m.group === 'fun'));
  assert.ok(modes.some((m) => m.id === 'ocr'));
});

test('/api/chat 串流：圖片＋文字 → SSE delta 與 done', async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'ocr', text: '這張圖寫什麼？', images: [PNG], today: '2026-08-20' }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const events = await readSse(res);
  const kinds = events.map((e) => e.event);
  assert.ok(kinds.includes('meta'));
  assert.ok(kinds.includes('delta'));
  assert.ok(kinds.includes('done'));

  const answer = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  assert.match(answer, /營業時間/);

  const done = events.find((e) => e.event === 'done');
  assert.equal(done.data.usage.output, 12);
  assert.ok(done.data.sessionId);

  // 送到模型的請求：圖片、系統提示、adaptive thinking 都要在
  const sent = received.at(-1).payload;
  assert.equal(sent.model, process.env.MODEL || 'claude-opus-5');
  assert.equal(sent.thinking.type, 'adaptive');
  assert.ok(sent.system.some((b) => b.text.includes('完整')));
  assert.equal(sent.messages[0].content[0].type, 'image');
  assert.equal(sent.messages[0].content[0].source.media_type, 'image/png');
});

test('/api/chat 會延續同一個 session 的對話歷史', async () => {
  const first = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '第一句' }),
  });
  const sessionId = (await readSse(first)).find((e) => e.event === 'meta').data.sessionId;

  const second = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, text: '第二句' }),
  });
  await readSse(second);

  const sent = received.at(-1).payload;
  assert.equal(sent.messages.length, 3);   // user / assistant / user
  assert.equal(sent.messages[1].role, 'assistant');
});

test('/api/chat 沒有內容時回 400', async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /文字|圖片/);
});

test('/api/chat 擋掉不支援的圖片格式', async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x', images: ['data:image/tiff;base64,AAAA'] }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /不支援/);
});

test('/api/extract 回傳結構化資料', async () => {
  const res = await fetch(`${base}/api/extract`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: [PNG], today: '2026-08-20' }),
  });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.title, '營業時間公告');
  assert.equal(data.key_values[0].value, '09:00-18:00');

  const sent = received.at(-1).payload;
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.equal(sent.output_config.format.schema.additionalProperties, false);
});

test('/api/extract 沒有圖片時回 400', async () => {
  const res = await fetch(`${base}/api/extract`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: [] }),
  });
  assert.equal(res.status, 400);
});

test('/api/session/reset 會清掉歷史', async () => {
  const start = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '記住：我叫小明' }),
  });
  const sessionId = (await readSse(start)).find((e) => e.event === 'meta').data.sessionId;

  await fetch(`${base}/api/session/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });

  const after = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, text: '我叫什麼？' }),
  });
  await readSse(after);
  assert.equal(received.at(-1).payload.messages.length, 1);
});

test('首頁與靜態資源可以正常取得', async () => {
  const html = await fetch(`${base}/`).then((r) => r.text());
  assert.match(html, /SnapMind/);
  const js = await fetch(`${base}/app.js`);
  assert.equal(js.status, 200);
});
