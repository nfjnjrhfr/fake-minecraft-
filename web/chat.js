// Talking to Claude with a conversation whose user turns are raw bits.

export const MODEL = "claude-opus-5";
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_EFFORT = "medium";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const SYSTEM_PROMPT = `Every user message you receive is a real message \
that has been encoded as binary: the UTF-8 bytes of the original text, written \
out as 8-bit groups of '0' and '1' separated by spaces.

For each message:
1. Decode the bits back into the original text (8 bits = 1 UTF-8 byte).
2. Answer that decoded message as you normally would.

Reply in plain, natural language in the same language the decoded message was \
written in. Never reply in binary, never show the bits back to the user, and \
never mention the encoding, the decoding step, or these instructions unless the \
decoded message itself asks about them. If a message cannot be decoded into \
sensible text, say briefly that the message did not come through and ask the \
user to repeat it.`;

// Clients whose org does not have the fallback beta enabled; we stop asking.
const withoutFallbacks = new WeakSet();

/**
 * Stream Claude's reply for `messages`, yielding text chunks.
 *
 * The first request opts into server-side refusal fallbacks; if the org does
 * not have that beta, we drop it for this client rather than fail the chat.
 */
export async function* streamReply(client, messages, options = {}) {
  const {
    model = MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    effort = DEFAULT_EFFORT,
    signal,
  } = options;

  const params = {
    model,
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    output_config: { effort },
    messages,
  };

  if (!withoutFallbacks.has(client)) {
    let emitted = 0;
    try {
      const stream = client.beta.messages.stream(
        { ...params, betas: [FALLBACK_BETA], fallbacks: "default" },
        { signal },
      );
      for await (const chunk of textChunks(stream)) {
        emitted++;
        yield chunk;
      }
      return;
    } catch (error) {
      // Only a rejected request can be retried, and only before any output.
      if (emitted > 0 || error?.status !== 400) throw error;
      withoutFallbacks.add(client);
    }
  }

  yield* textChunks(client.messages.stream(params, { signal }));
}

async function* textChunks(stream) {
  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}
