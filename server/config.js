import 'dotenv/config';

/** 主模型：Claude Opus 5。可用 MODEL 環境變數覆寫。 */
export const MODEL = process.env.MODEL || 'claude-opus-5';

/** 串流回應給足空間，避免長文被截斷。 */
export const MAX_TOKENS = Number(process.env.MAX_TOKENS || 16000);
export const STREAM_MAX_TOKENS = Number(process.env.STREAM_MAX_TOKENS || 32000);

export const PORT = Number(process.env.PORT || 3000);

/**
 * 允許瀏覽器端自帶金鑰（存在該裝置的 localStorage，隨請求送到本機伺服器）。
 * 若要部署到公開網路，請設 ALLOW_CLIENT_KEY=false 並只用伺服器端金鑰。
 */
export const ALLOW_CLIENT_KEY = process.env.ALLOW_CLIENT_KEY !== 'false';

/** 單張圖片上限（base64 解碼後），與 API 的 5MB/張限制對齊。 */
export const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 5 * 1024 * 1024);
export const MAX_IMAGES_PER_TURN = Number(process.env.MAX_IMAGES_PER_TURN || 6);

/** 對話保留的輪數；更舊的內容會被裁掉以控制花費。 */
export const HISTORY_TURNS = Number(process.env.HISTORY_TURNS || 24);
/** 只有最近幾輪的使用者訊息保留原圖，更早的圖片改成文字佔位。 */
export const IMAGE_MEMORY_TURNS = Number(process.env.IMAGE_MEMORY_TURNS || 3);

export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 3 * 60 * 60 * 1000);
export const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 500);
