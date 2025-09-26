import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const PROVIDER = process.env.PROVIDER || 'ollama';

// naive in-memory cache; replace with Redis later
const answerCache = new Map();
const cacheKey = (messages) => JSON.stringify(messages);

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, stream = true } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages[] required' });
    }

    // Check cache (exact match for now)
    const key = cacheKey(messages);
    if (!stream && answerCache.has(key)) {
      return res.json(answerCache.get(key));
    }

    // Set up SSE for streaming
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
    }

    // Route to provider
    if (PROVIDER === 'ollama') {
      await handleOllama(messages, stream, res);
    } else if (PROVIDER === 'openai_compat') {
      await handleOpenAICompat(messages, stream, res);
    } else {
      throw new Error(`Unknown PROVIDER: ${PROVIDER}`);
    }

  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT} (PROVIDER=${PROVIDER})`);
});

/* ---------- Providers ---------- */

async function handleOllama(messages, stream, res) {
  // Ollama chat API: POST /api/chat  { model, messages, stream }
  const model = process.env.OLLAMA_MODEL || 'llama3.1';

    console.log('[LLM][OLLAMA][REQUEST]', JSON.stringify({ 
    url: 'http://localhost:11434/api/chat',
    model, 
    stream: !!stream, 
    messages 
    }, null, 2));

  const resp = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: !!stream })
  });

  if (!stream) {
    const json = await resp.json();

    const text = (json && json.message && json.message.content) || '';
    const data = { content: text, provider: 'ollama' };
    answerCache.set(JSON.stringify(messages), data);
    return res.json(data);
  }

  // streaming: Ollama returns NDJSON lines
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const token = obj?.message?.content || '';
        full += token;
        res.write(`data: ${token}\n\n`);
      } catch {
        // ignore bad lines
      }
    }
  }
  res.end();
  answerCache.set(JSON.stringify(messages), { content: full, provider: 'ollama' });
}

async function handleOpenAICompat(messages, stream, res) {
  // Works with vLLM OpenAI-compatible server or TGI OpenAI-style proxies
  const base = process.env.LLM_BASE_URL || 'http://localhost:8000';
  const apiKey = process.env.LLM_API_KEY || 'none';
  const model = process.env.OPENAI_COMPAT_MODEL || 'llama-3-8b-instruct';

  const body = {
    model,
    messages,
    stream: !!stream,
    // keep it simple; add more params as needed:
    temperature: 0.2,
    max_tokens: 512
  };

  const resp = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!stream) {
    const json = await resp.json();
    const text = json?.choices?.[0]?.message?.content || '';
    const data = { content: text, provider: 'openai_compat' };
    answerCache.set(JSON.stringify(messages), data);
    return res.json(data);
  }

  // streaming uses OpenAI's "data: ..." chunked format
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
    //   const payload = line.slice(5).replace(/^ /, '');

      if (payload === '[DONE]') {

        // res.write(`event: done\ndata: ${JSON.stringify({ content: full })}\n\n`);

        res.write(`data: [DONE]\n\n`);

        res.end();
        answerCache.set(JSON.stringify(messages), { content: full, provider: 'ollama' });
        return;
      }
      try {
        const obj = JSON.parse(payload);
        const delta = obj?.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          res.write(`data: ${delta}\n\n`);
        }
      } catch {
        // ignore
      }
    }
  }
}
