#!/usr/bin/env node
/**
 * 終端機版：snapmind ask
 *   npm run ask -- 照片.jpg "這張收據總共多少錢？"
 *   npm run ask -- --mode ocr 白板.png
 *   npm run ask -- --mode roast a.jpg b.jpg
 */
import fs from 'node:fs';
import path from 'node:path';
import { MODEL, STREAM_MAX_TOKENS } from '../server/config.js';
import { describeError, getClient } from '../server/claude.js';
import { buildSystem, defaultTask, getMode, MODE_IDS } from '../server/prompts.js';

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

function parseArgs(argv) {
  const args = { mode: 'chat', files: [], words: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode' || a === '-m') args.mode = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (MIME[path.extname(a).toLowerCase()] && fs.existsSync(a)) args.files.push(a);
    else args.words.push(a);
  }
  args.text = args.words.join(' ');
  return args;
}

function usage() {
  console.log(`用法：npm run ask -- [--mode <模式>] [圖片...] [問題]

模式：${MODE_IDS.join(', ')}

範例：
  npm run ask -- 收據.jpg "總共多少錢？"
  npm run ask -- --mode ocr 白板.png
  npm run ask -- "幫我把這段話翻成日文：早安"`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.files.length && !args.text)) {
  usage();
  process.exit(args.help ? 0 : 1);
}

const content = args.files.map((file) => ({
  type: 'image',
  source: {
    type: 'base64',
    media_type: MIME[path.extname(file).toLowerCase()],
    data: fs.readFileSync(file).toString('base64'),
  },
}));
content.push({ type: 'text', text: args.text || defaultTask(args.mode) });

const today = new Date().toISOString().slice(0, 10);

try {
  const client = getClient();
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: STREAM_MAX_TOKENS,
    system: buildSystem(args.mode, { today }),
    messages: [{ role: 'user', content }],
    thinking: { type: 'adaptive' },
    output_config: { effort: getMode(args.mode).effort },
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      process.stdout.write(event.delta.text);
    }
  }
  const final = await stream.finalMessage();
  process.stdout.write(`\n\n— ${MODEL} · 輸入 ${final.usage.input_tokens} / 輸出 ${final.usage.output_tokens} tokens\n`);
} catch (err) {
  const { message } = describeError(err);
  console.error('\n錯誤：' + message);
  process.exit(1);
}
