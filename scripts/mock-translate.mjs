// 本地假翻译服务：OpenAI 兼容的 /v1/chat/completions，用来在没有真实密钥时自测后台翻译链路。
// 用法：pnpm mock:translate  （默认监听 127.0.0.1:8791，可用 MOCK_TRANSLATE_PORT 换端口）
// 后台「系统设置 → 内容翻译」里把 provider 选 openai、endpoint 填 http://127.0.0.1:8791/v1、密钥填 test-key。
import http from 'node:http';

const port = Number(process.env.MOCK_TRANSLATE_PORT ?? 8791);

const server = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (chunk) => (buf += chunk));
  req.on('end', () => {
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const auth = req.headers.authorization ?? '';
    let body = {};
    try {
      body = JSON.parse(buf);
    } catch {
      body = {};
    }
    const user = body.messages?.[1]?.content ?? '';
    const keyed = auth === 'Bearer test-key' ? 'ok' : 'nokey';
    const content = `[MOCK ${body.model ?? '?'} → ${keyed}] ${String(user).slice(0, 60)}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock translate on http://127.0.0.1:${port}/v1/chat/completions`);
});
