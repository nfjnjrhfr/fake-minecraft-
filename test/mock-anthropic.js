import http from 'node:http';

/**
 * 假的 Anthropic API，用來在沒有真金鑰的情況下驗證伺服器端流程
 * （SSE 串流轉送、結構化輸出解析、錯誤處理）。
 */
export function startMockApi({ text = '你好，這是測試回覆。', json = null } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      received.push({ url: req.url, payload });

      if (payload.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_mock', type: 'message', role: 'assistant', model: payload.model,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 42, output_tokens: 0, cache_read_input_tokens: 7 },
          },
        });
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        for (const chunk of text.match(/.{1,4}/gs) || []) {
          send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } });
        }
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 12 },
        });
        send('message_stop', { type: 'message_stop' });
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_mock', type: 'message', role: 'assistant', model: payload.model,
        content: [{ type: 'text', text: json ? JSON.stringify(json) : text }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 42, output_tokens: 12 },
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}
