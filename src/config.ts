/** Runtime configuration for SGPT, resolved from the environment. */

export interface ModelInfo {
  /** Exact Anthropic model id. */
  id: string;
  /** Name shown in the model picker. */
  label: string;
  /** One-line description shown under the label. */
  blurb: string;
  /** Whether the model accepts `output_config.effort`. */
  supportsEffort: boolean;
  /** Whether the model accepts adaptive thinking. */
  supportsThinking: boolean;
  /** Hard cap on `max_tokens` for this model; exceeding it is a 400. */
  maxOutputTokens: number;
}

/**
 * Models SGPT can talk to. The first entry is the default and is what the
 * product is tuned for; the others are there for users who want to trade
 * capability for cost or latency.
 */
export const MODELS: ModelInfo[] = [
  {
    id: "claude-opus-5",
    label: "SGPT-5",
    blurb: "最強推理，適合寫程式與複雜分析",
    supportsEffort: true,
    supportsThinking: true,
    maxOutputTokens: 128000,
  },
  {
    id: "claude-sonnet-5",
    label: "SGPT-5 Balanced",
    blurb: "速度與品質兼顧的日常選擇",
    supportsEffort: true,
    supportsThinking: true,
    maxOutputTokens: 128000,
  },
  {
    id: "claude-haiku-4-5",
    label: "SGPT-mini",
    blurb: "最快、最便宜，適合簡單問答",
    supportsEffort: false,
    supportsThinking: false,
    maxOutputTokens: 64000,
  },
];

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export function modelById(id: string | undefined): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]!;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "no", "off", ""].includes(raw.toLowerCase());
}

export const config = {
  port: envInt("PORT", 3000),
  defaultModel: process.env.SGPT_MODEL || MODELS[0]!.id,
  defaultEffort: (EFFORT_LEVELS as readonly string[]).includes(
    process.env.SGPT_EFFORT ?? "",
  )
    ? (process.env.SGPT_EFFORT as Effort)
    : ("high" as Effort),
  maxTokens: envInt("SGPT_MAX_TOKENS", 64000),
  /** Server-side refusal fallbacks keep the app answering instead of dead-ending. */
  fallbacks: envFlag("SGPT_FALLBACKS", true),
  dataDir: process.env.SGPT_DATA_DIR || "./data/conversations",
  /** Ceiling on a single uploaded attachment, in bytes. */
  maxAttachmentBytes: envInt("SGPT_MAX_ATTACHMENT_BYTES", 12 * 1024 * 1024),
  /** Ceiling on a single JSON request body, protects against runaway pastes. */
  maxRequestBody: process.env.SGPT_MAX_BODY || "40mb",
} as const;

/**
 * The SDK resolves credentials from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
 * or an `ant auth login` profile — so an unset API key is not proof that the
 * app is unconfigured. We only warn.
 */
export function hasExplicitApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
