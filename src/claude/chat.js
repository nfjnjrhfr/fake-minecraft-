#!/usr/bin/env node
// 用 Anthropic 官方 SDK 做的終端機聊天：多輪對話、串流輸出、工具呼叫。
// 這是 repo 裡唯一需要 npm install 的部分（另外兩個 AI 都是零相依）。
import readline from 'node:readline';
import Anthropic from '@anthropic-ai/sdk';
import { ALL_TOOLS } from './tools.js';
import { runTurn, describeError, DEFAULT_MODEL } from './session.js';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const k = process.argv[i].slice(2);
    const v = process.argv[i + 1];
    args[k] = v && !v.startsWith('--') ? (isNaN(Number(v)) ? v : Number(v)) : true;
  }
}

const MODEL = args.model || DEFAULT_MODEL;
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const client = new Anthropic(); // 依序找 ANTHROPIC_API_KEY、ANTHROPIC_AUTH_TOKEN、ant auth login 的設定檔
let messages = [];
let showThinking = args.thinking === true;
let busy = false; // 生成中就先別處理新輸入，避免一輪還沒跑完又送出下一輪
const total = { input: 0, output: 0 };

console.log(`${CYAN}Claude 聊天（${MODEL}）${RESET}
可用工具：${ALL_TOOLS.map((t) => t.name).join('、')}
指令：/reset 清空對話　/thinking 切換顯示思考　/usage 看用量　exit 離開
`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt('你：');
rl.prompt();

rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (busy) {
    console.log('（還在回答上一句，請等一下）');
    return;
  }
  if (text === 'exit' || text === 'quit') return rl.close();
  if (text === '/reset') {
    messages = [];
    console.log('（對話已清空）\n');
    return rl.prompt();
  }
  if (text === '/thinking') {
    showThinking = !showThinking;
    console.log(`（思考過程：${showThinking ? '顯示' : '隱藏'}）\n`);
    return rl.prompt();
  }
  if (text === '/usage') {
    console.log(`（累計 input ${total.input} tokens、output ${total.output} tokens）\n`);
    return rl.prompt();
  }

  busy = true;
  try {
    process.stdout.write(`${CYAN}Claude：${RESET}`);
    let thinkingOpen = false;
    const result = await runTurn({
      client,
      messages,
      userText: text,
      model: MODEL,
      onText: (t) => {
        if (thinkingOpen) {
          process.stdout.write(`${RESET}\n`);
          thinkingOpen = false;
        }
        process.stdout.write(t);
      },
      onThinking: showThinking
        ? (t) => {
            if (!thinkingOpen) {
              process.stdout.write(`\n${DIM}[思考] `);
              thinkingOpen = true;
            }
            process.stdout.write(t);
          }
        : null,
      onToolUse: (name, input) =>
        console.log(`\n${YELLOW}⚙ 呼叫工具 ${name}(${JSON.stringify(input)})${RESET}`),
      onRefusal: (cat) =>
        console.log(`\n${YELLOW}（這次請求被拒絕：${cat ?? '未說明'}）${RESET}`),
    });
    messages = result.messages;
    total.input += result.usage.input;
    total.output += result.usage.output;
    console.log('\n');
  } catch (err) {
    console.error(`\n${YELLOW}${describeError(err)}${RESET}\n`);
  }
  busy = false;
  rl.prompt();
});
rl.on('close', () => {
  console.log('再見。');
  process.exit(0);
});
