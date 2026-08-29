// 一輪對話的核心邏輯，終端機版與網頁版共用。
import Anthropic from '@anthropic-ai/sdk';
import { ALL_TOOLS, SYSTEM_PROMPT } from './tools.js';

export const DEFAULT_MODEL = 'claude-opus-5';

export function buildParams(messages, { model = DEFAULT_MODEL, tools = ALL_TOOLS, system = SYSTEM_PROMPT } = {}) {
  return {
    model,
    max_tokens: 64000,
    system,
    messages,
    tools,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'high' },
    // Claude Opus 5 的伺服器端備援：某次請求被安全分類器擋下時，
    // 同一個呼叫會自動改用備援模型接手，而不是整個中斷。
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    stream: true,
    max_iterations: 10,
  };
}

/**
 * 送出一輪對話並串流回應。
 * 工具呼叫交給 SDK 的 tool runner：Claude 說要用工具 → SDK 執行我們的函式 →
 * 結果餵回去 → 直到它給出最終回答。
 *
 * @returns {Promise<{messages: Array, usage: {input: number, output: number}}>}
 *          messages 已包含這一輪所有的工具呼叫與結果，可直接當下一輪的歷史
 */
export async function runTurn({
  client,
  messages,
  userText,
  model = DEFAULT_MODEL,
  tools = ALL_TOOLS,
  onText = () => {},
  onThinking = null,
  onToolUse = () => {},
  onRefusal = () => {},
}) {
  const history = [...messages, { role: 'user', content: userText }];
  const runner = client.beta.messages.toolRunner(buildParams(history, { model, tools }));
  const usage = { input: 0, output: 0 };

  for await (const stream of runner) {
    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'text_delta') onText(event.delta.text);
      else if (event.delta.type === 'thinking_delta' && onThinking) onThinking(event.delta.thinking);
    }

    const message = await stream.finalMessage();
    usage.input += message.usage?.input_tokens ?? 0;
    usage.output += message.usage?.output_tokens ?? 0;

    // 伺服器端工具跑太久會先停在 pause_turn，把這一輪推回去就能接著跑
    if (message.stop_reason === 'pause_turn') {
      runner.pushMessages({ role: 'assistant', content: message.content });
      continue;
    }
    if (message.stop_reason === 'refusal') {
      onRefusal(message.stop_details?.category ?? null);
    }
    for (const block of message.content) {
      if (block.type === 'tool_use') onToolUse(block.name, block.input);
    }
  }

  return { messages: [...runner.params.messages], usage };
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return '認證失敗：請設定 ANTHROPIC_API_KEY，或先跑 `ant auth login`。';
  }
  if (err instanceof Anthropic.RateLimitError) return '被限流了，等一下再試。';
  if (err instanceof Anthropic.BadRequestError) return `請求有問題：${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return `連不上 API：${err.message}`;
  if (err instanceof Anthropic.APIError) return `API 錯誤 ${err.status}：${err.message}`;
  return `發生錯誤：${err.message}`;
}
