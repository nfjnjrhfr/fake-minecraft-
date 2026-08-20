import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { ALLOW_CLIENT_KEY } from './config.js';

const cache = new Map();

/** 伺服器端是否已備妥金鑰（環境變數 / ant auth 設定檔皆算）。 */
export function serverKeyConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export class MissingKeyError extends Error {
  constructor() {
    super('尚未設定 API 金鑰：請在 .env 填入 ANTHROPIC_API_KEY，或在網頁右上角「設定」貼上金鑰。');
    this.name = 'MissingKeyError';
    this.status = 401;
  }
}

/**
 * 取得 Anthropic client。
 * 優先用伺服器端金鑰；沒有的話才用瀏覽器帶來的金鑰（可用 ALLOW_CLIENT_KEY 關閉）。
 */
export function getClient(clientKey) {
  if (serverKeyConfigured()) {
    if (!cache.has('server')) cache.set('server', new Anthropic());
    return cache.get('server');
  }
  const key = ALLOW_CLIENT_KEY && typeof clientKey === 'string' ? clientKey.trim() : '';
  if (!key) throw new MissingKeyError();
  if (!cache.has(key)) {
    if (cache.size > 32) cache.clear();
    cache.set(key, new Anthropic({ apiKey: key }));
  }
  return cache.get(key);
}

/** 把 SDK 的錯誤轉成前端看得懂的訊息。 */
export function describeError(err) {
  if (err instanceof MissingKeyError) return { status: 401, message: err.message };
  if (err instanceof AuthenticationError) {
    return { status: 401, message: 'API 金鑰無效或已失效，請重新設定。' };
  }
  if (err instanceof PermissionDeniedError) {
    return { status: 403, message: '這把金鑰沒有存取此模型的權限。' };
  }
  if (err instanceof RateLimitError) {
    return { status: 429, message: '請求太頻繁或額度用盡，稍候再試。' };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, message: `找不到模型或資源：${err.message}` };
  }
  if (err instanceof APIConnectionError) {
    return { status: 502, message: '連不上 Claude API，請檢查網路或 proxy 設定。' };
  }
  if (err instanceof APIError) {
    return { status: err.status || 500, message: `API 回報錯誤（${err.status ?? '-'}）：${err.message}` };
  }
  return { status: 500, message: err?.message || '未知錯誤' };
}
