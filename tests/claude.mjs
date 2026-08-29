// Claude 聊天層的測試。
// 沒有 API key 也能跑：架一個假的 Anthropic API，回傳跟真的一模一樣格式的 SSE，
// 藉此驗證串流解析、工具呼叫迴圈、對話歷史與錯誤處理。
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { runTurn, buildParams, describeError, DEFAULT_MODEL } from '../src/claude/session.js';
import { ALL_TOOLS, askMiniGpt, playMinicraft, readProjectFile } from '../src/claude/tools.js';
import { cleanPairs, pairsToText, buildPrompt, generateBatch } from '../src/gpt/distill.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

function textTurn(text) {
  return sse([
    { type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', model: DEFAULT_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...[...text].map((ch) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ch } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ]);
}

function toolTurn(name, input) {
  return sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: DEFAULT_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '我應該去問那個小模型。' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 15 } },
    { type: 'message_stop' },
  ]);
}

/** 假的 Anthropic API：第一次回傳工具呼叫，第二次回傳最終文字 */
function startMockApi(script) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });
      const step = script[Math.min(requests.length - 1, script.length - 1)];
      if (step.status && step.status !== 200) {
        res.writeHead(step.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(step.sse);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, requests, port: server.address().port }));
  });
}

console.log('\n[1] 請求參數的形狀');
{
  const p = buildParams([{ role: 'user', content: '嗨' }]);
  check('用 claude-opus-5', p.model === 'claude-opus-5');
  check('開啟 adaptive thinking', p.thinking.type === 'adaptive' && p.thinking.display === 'summarized');
  check('串流開啟、max_tokens 夠大', p.stream === true && p.max_tokens >= 16000, `max_tokens=${p.max_tokens}`);
  check('帶上 Opus 5 的伺服器端備援', p.fallbacks === 'default' && p.betas.includes('server-side-fallback-2026-07-01'));
  check('三個工具都掛上去了', p.tools.length === 3, p.tools.map((t) => t.name).join('、'));
}

console.log('\n[2] 串流 + 工具呼叫的完整迴圈（對著假 API 跑）');
{
  const { server, requests, port } = await startMockApi([
    { sse: toolTurn('ask_mini_gpt', { question: '你是誰' }) },
    { sse: textTurn('小方塊說它叫小方塊。') },
  ]);
  const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}` });

  let text = '';
  let thinking = '';
  const tools = [];
  const result = await runTurn({
    client,
    messages: [],
    userText: '幫我問 mini-GPT 它是誰',
    onText: (t) => (text += t),
    onThinking: (t) => (thinking += t),
    onToolUse: (name, input) => tools.push({ name, input }),
  });

  check('串流的文字有逐字收到', text === '小方塊說它叫小方塊。', `「${text}」`);
  check('思考內容有收到', thinking.includes('小模型'), `「${thinking}」`);
  check('有回報工具呼叫', tools.length === 1 && tools[0].name === 'ask_mini_gpt', JSON.stringify(tools));
  check('用量有累加（兩次請求）', result.usage.output === 24 && result.usage.input === 30, JSON.stringify(result.usage));

  check('總共送出兩次請求', requests.length === 2);
  const second = requests[1].body;
  const toolResult = second.messages.at(-1).content.find((b) => b.type === 'tool_result');
  check('工具真的被執行，結果餵回 API', !!toolResult && String(toolResult.content).includes('小方塊'),
    JSON.stringify(toolResult?.content).slice(0, 60));
  check('beta 標頭有帶出去', String(requests[0].headers['anthropic-beta'] || '').includes('server-side-fallback'),
    requests[0].headers['anthropic-beta']);

  const roles = result.messages.map((m) => m.role).join(',');
  check('回傳的歷史包含工具往返', roles === 'user,assistant,user,assistant', roles);

  // 第二輪：歷史要接得上
  const { server: s2, requests: r2, port: p2 } = await startMockApi([{ sse: textTurn('好的。') }]);
  const client2 = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${p2}` });
  await runTurn({ client: client2, messages: result.messages, userText: '謝謝' });
  check('第二輪會把前面的對話一起送出', r2[0].body.messages.length === 5, `${r2[0].body.messages.length} 則`);
  server.close();
  s2.close();
}

console.log('\n[3] 錯誤處理');
{
  const { server, port } = await startMockApi([{ status: 401 }]);
  const client = new Anthropic({ apiKey: 'bad', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 });
  let msg = '';
  try {
    await runTurn({ client, messages: [], userText: '嗨' });
  } catch (err) {
    msg = describeError(err);
  }
  check('401 會被翻成看得懂的訊息', msg.includes('認證失敗'), msg);
  check('未知錯誤也有預設訊息', describeError(new Error('boom')).includes('boom'));
  server.close();
}

console.log('\n[4] 工具本身');
{
  const answer = await askMiniGpt.run({ question: '你是誰' });
  check('ask_mini_gpt 會轉給 mini-GPT', answer.includes('小方塊'), answer);

  const play = await playMinicraft.run({ episodes: 1, seed: 42 });
  check('play_minicraft 會實際跑一回合並畫出地圖', /採集 \d+\/30 分/.test(play) && play.includes('@'));

  const denied = await readProjectFile.run({ path: '../../etc/passwd' });
  check('read_project_file 擋掉 repo 外的路徑', denied.startsWith('拒絕讀取'), denied);
  const ok = await readProjectFile.run({ path: 'package.json', maxChars: 300 });
  check('read_project_file 讀得到 repo 內的檔案', ok.includes('minicraft-ai'));
  check('工具都有描述，Claude 才知道何時該用', ALL_TOOLS.every((t) => t.description && t.description.length > 20));
}

console.log('\n[5] 知識蒸餾管線');
{
  // 清洗規則：太長、含英數字、重複的都要濾掉
  const cleaned = cleanPairs([
    { question: '天空是什麼顏色', answer: '天空是藍色的。' },
    { question: '天空是什麼顏色', answer: '重複的問題' },
    { question: '什麼是 API', answer: '含英文字母應該被濾掉。' },
    { question: '講一個很長很長超過限制的答案好嗎', answer: '這一組的問題太長了，應該被濾掉。' },
    { question: '水幾度結冰', answer: '這個答案故意寫得非常非常長，長到超過二十四個字的上限所以要被濾掉。' },
    { question: '', answer: '空問題' },
  ]);
  check('清洗後只留下合格的那一組', cleaned.length === 1 && cleaned[0][0] === '天空是什麼顏色',
    JSON.stringify(cleaned));

  const text = pairsToText([['你好', '你好呀。']], { samples: 3 });
  check('轉成訓練語料的格式正確', text === '問：你好\n答：你好呀。\n'.repeat(3), JSON.stringify(text));

  check('提示詞有把長度限制講清楚', /不超過 20 個字/.test(buildPrompt('測試', 10, 20, [])));

  // 對著假 API 驗證結構化輸出的解析
  const payload = { pairs: [{ question: '貓怎麼叫', answer: '貓會喵喵叫。' }] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_x', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 5 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const client = new Anthropic({ apiKey: 'test', baseURL: `http://127.0.0.1:${server.address().port}` });
  const got = await generateBatch(client, { topic: '動物', count: 1 });
  check('結構化輸出有被解析出來', got.length === 1 && got[0].answer === '貓會喵喵叫。', JSON.stringify(got));
  server.close();
}

console.log(`\n總結：${pass} 通過，${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
