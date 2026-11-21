// Study Hub server: serves the app, stores your data in data/db.json,
// and forwards AI requests to Google Gemini (free tier) or Anthropic Claude using your own key.
// No dependencies: needs Node 18 or newer.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const env = k => (process.env[k] || '').trim();

// ---------- AI providers ----------
// Gemini is the default (free key from Google AI Studio). Claude still works if an Anthropic
// key is set and no Gemini key is, or when AI_PROVIDER=anthropic.
// STUDYHUB_API_KEY is an alternative name for the Anthropic key, for places where
// ANTHROPIC_API_KEY is reserved (for example Claude Code cloud sessions).
const GEMINI_KEY = env('GEMINI_API_KEY') || env('GOOGLE_API_KEY');
const ANTHROPIC_KEY = env('STUDYHUB_API_KEY') || env('ANTHROPIC_API_KEY');
const PROVIDERS = {
  gemini: {
    name: 'Google Gemini',
    key: GEMINI_KEY,
    // Model names change over time: override them in .env if Google retires one.
    models: {
      quick: env('GEMINI_MODEL_QUICK') || 'gemini-3.5-flash-lite',
      default: env('GEMINI_MODEL_DEFAULT') || 'gemini-3.5-flash',
      complex: env('GEMINI_MODEL_COMPLEX') || 'gemini-3.5-flash',
    },
    // Thinking counts toward the output limit on Gemini 2.5 models too.
    maxTokens: { quick: 16384, default: 32768, complex: 65536 },
    // The free tier allows only a few requests per minute, so the browser sends fewer at once.
    concurrency: Number(env('AI_CONCURRENCY')) || 2,
  },
  anthropic: {
    name: 'Anthropic Claude',
    key: ANTHROPIC_KEY,
    models: {
      quick: env('MODEL_QUICK') || 'claude-haiku-5-5',
      default: env('MODEL_DEFAULT') || 'claude-sonnet-5-5',
      complex: env('MODEL_COMPLEX') || 'claude-opus-5-5',
    },
    // These models think before they answer, and thinking counts toward max_tokens.
    maxTokens: { quick: 16000, default: 32000, complex: 64000 },
    effort: { quick: 'low', default: 'medium', complex: 'high' },
    concurrency: Number(env('AI_CONCURRENCY')) || 4,
  },
};
const PROVIDER_ID = (() => {
  const want = env('AI_PROVIDER').toLowerCase();
  if (PROVIDERS[want]) return want;
  if (GEMINI_KEY) return 'gemini';
  if (ANTHROPIC_KEY) return 'anthropic';
  return 'gemini';
})();
const AI = PROVIDERS[PROVIDER_ID];
const MODELS = AI.models;
// Server-side refusal fallback (Anthropic beta). Haiku has none, so it is only sent for the other tiers.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const USE_FALLBACK = { quick: false, default: true, complex: true };
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC = path.join(ROOT, 'public');
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const LOCAL_ONLY = LOOPBACK.has(HOST);
// Markers the browser reads at the end of a streamed reply.
const MARK = { cut: '\n[[studyhub:cut_off]]', refusal: '\n[[studyhub:refusal]]', error: '\n[[studyhub:error]]' };

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m || m[1] in process.env) continue;
    let v = m[2].trim();
    const q = v.match(/^(['"])(.*)\1$/);
    if (q) v = q[2]; else v = v.replace(/\s+#.*$/, '').trim();
    process.env[m[1]] = v;
  }
}

// ---------- storage: one JSON file, written atomically ----------
let db = {};
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!db || typeof db !== 'object' || Array.isArray(db)) throw new Error('not an object');
} catch (err) {
  db = {};
  if (err.code !== 'ENOENT' && fs.existsSync(DB_FILE)) {
    // Never overwrite a file we could not read: keep a copy so nothing is lost.
    const copy = DB_FILE + '.broken-' + Date.now();
    fs.copyFileSync(DB_FILE, copy);
    console.error(`Could not read ${DB_FILE} (${err.message}). A copy was saved as ${copy}. Starting with empty data.`);
  }
}
let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain.then(async () => {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(db));
    await fs.promises.rename(tmp, DB_FILE);
  });
  const done = writeChain;
  writeChain = writeChain.catch(err => console.error('Could not save data:', err.message));
  return done;
}

// ---------- helpers ----------
const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(httpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(httpError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

// Blocks other websites from using this server: a page you visit could otherwise
// spend your API credits or change your data through http://localhost.
function allowed(req) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (LOCAL_ONLY && !LOOPBACK.has(host)) return 'Unknown host';
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try { if (new URL(origin).host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) return 'Cross-site request blocked'; }
    catch { return 'Bad origin'; }
  } else if (origin === 'null') return 'Cross-site request blocked';
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return 'Content-Type must be application/json';
  }
  return null;
}

// ---------- AI: one endpoint, two providers, always streamed back as plain text ----------
const NO_KEY_MSG = 'AI is off. Get a free key at https://aistudio.google.com/apikey, put GEMINI_API_KEY=your-key in the .env file, and restart the server.';
async function handleAI(req, res) {
  if (!AI.key) return send(res, 400, { code: 'no_key', message: NO_KEY_MSG });
  const body = await readBody(req);
  const tier = MODELS[body.tier] ? body.tier : 'default';
  const messages = Array.isArray(body.messages) ? body.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()).map(m => ({ role: m.role, content: m.content })) : [];
  if (!messages.length || messages[0].role !== 'user' || messages[messages.length - 1].role !== 'user') return send(res, 400, { code: 'invalid', message: 'Messages must start and end with a user message.' });
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter(i => i && /^image\/(jpeg|png|webp|gif)$/.test(i.media_type) && typeof i.data === 'string' && i.data.length)
    .slice(0, 8);

  // Stop the upstream request if the browser goes away, so no quota or credits are wasted.
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });

  const call = PROVIDER_ID === 'gemini' ? geminiRequest(tier, messages, images) : anthropicRequest(tier, messages, images);
  let upstream;
  try {
    upstream = await fetch(call.url, { method: 'POST', headers: call.headers, body: JSON.stringify(call.body), signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) return;
    return send(res, 502, { code: 'network', message: 'Could not reach the AI service. Check your internet connection.' });
  }
  if (!upstream.ok) {
    let j = null; try { j = await upstream.json(); } catch {}
    const e = (PROVIDER_ID === 'gemini' ? geminiError : anthropicError)(upstream.status, j);
    return send(res, e.code === 'rate_limited' || e.code === 'overloaded' || e.code === 'quota_day' ? 429 : 502, e);
  }

  // Re-stream only the answer text, plus a marker line if the reply was cut short.
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  const onEvent = PROVIDER_ID === 'gemini' ? geminiEvent : anthropicEvent;
  const state = { marked: false };
  const write = t => { if (t) res.write(t); };
  const mark = (m, detail) => { if (!state.marked) { state.marked = true; res.write(m + (detail ? ' ' + String(detail).replace(/\s+/g, ' ') : '')); } };
  const reader = upstream.body.getReader(); const dec = new TextDecoder(); let buf = '';
  const handle = line => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    let ev; try { ev = JSON.parse(line.slice(5)); } catch { return; }
    onEvent(ev, write, mark);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    if (buf) handle(buf);
  } catch (err) {
    if (!ctrl.signal.aborted) mark(MARK.error, 'The connection to the AI service dropped.');
  }
  res.end();
}

// ----- Google Gemini (generateContent REST API, streamed as server-sent events) -----
function geminiRequest(tier, messages, images) {
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  if (images.length) contents[contents.length - 1].parts.unshift(...images.map(i => ({ inline_data: { mime_type: i.media_type, data: i.data } })));
  const base = env('GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com';
  return {
    url: `${base}/v1beta/models/${encodeURIComponent(MODELS[tier])}:streamGenerateContent?alt=sse`,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': AI.key },
    body: { contents, generationConfig: { maxOutputTokens: AI.maxTokens[tier] } },
  };
}
const GEMINI_STOP_REFUSED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);
function geminiEvent(ev, write, mark) {
  if (ev.error) return mark(MARK.error, ev.error.message || 'unknown');
  if (ev.promptFeedback?.blockReason) return mark(MARK.refusal);
  const c = ev.candidates?.[0];
  if (!c) return;
  for (const p of c.content?.parts || []) if (typeof p.text === 'string' && !p.thought) write(p.text);
  if (c.finishReason === 'MAX_TOKENS') mark(MARK.cut);
  else if (GEMINI_STOP_REFUSED.has(c.finishReason)) mark(MARK.refusal);
}
function geminiError(status, j) {
  const err = j?.error || {};
  const details = Array.isArray(err.details) ? err.details : [];
  const reason = details.find(d => d.reason)?.reason || '';
  const msg = err.message || `AI request failed (${status}).`;
  if (reason === 'API_KEY_INVALID' || /api key not valid/i.test(msg) || status === 401) return { code: 'bad_key', message: 'Google rejected the Gemini API key. Check GEMINI_API_KEY in the .env file and restart the server.' };
  if (status === 403) return { code: 'bad_key', message: 'Google refused this request (' + msg + '). Check that the Gemini API key is correct and that the Gemini API is allowed for it.' };
  if (status === 404) return { code: 'bad_model', message: 'Google does not offer this model any more (' + msg + '). Set GEMINI_MODEL_DEFAULT (and _QUICK, _COMPLEX) in .env to a current model.' };
  if (status === 429) {
    const perDay = details.some(d => (d.violations || []).some(v => /PerDay/i.test(v.quotaId || '')));
    if (perDay) return { code: 'quota_day', message: 'You have used today\'s free Gemini limit for this model. It resets tomorrow (Pacific time).' };
    const delay = details.find(d => d.retryDelay)?.retryDelay;
    const secs = delay ? Math.ceil(parseFloat(delay)) : 20;
    return { code: 'rate_limited', retryAfter: Math.min(Math.max(secs, 1), 90), message: 'The free Gemini limit was reached for this minute. Retrying shortly…' };
  }
  if (status === 503 || status === 500) return { code: 'overloaded', retryAfter: 10, message: 'Gemini is busy right now. Try again in a moment.' };
  return { code: 'upstream', message: msg };
}

// ----- Anthropic Claude (Messages API, streamed) -----
function anthropicRequest(tier, messages, images) {
  messages = messages.map(m => ({ ...m }));
  if (images.length) {
    const last = messages[messages.length - 1];
    last.content = [...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })), { type: 'text', text: last.content }];
  }
  const body = { model: MODELS[tier], max_tokens: AI.maxTokens[tier], stream: true, output_config: { effort: AI.effort[tier] }, messages };
  const headers = { 'content-type': 'application/json', 'x-api-key': AI.key, 'anthropic-version': '2023-06-01' };
  if (USE_FALLBACK[tier] && env('DISABLE_FALLBACK') !== '1') { body.fallbacks = 'default'; headers['anthropic-beta'] = FALLBACK_BETA; }
  return { url: (env('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com') + '/v1/messages', headers, body };
}
function anthropicEvent(ev, write, mark) {
  if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') write(ev.delta.text);
  else if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'max_tokens') mark(MARK.cut);
  else if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'refusal') mark(MARK.refusal);
  else if (ev.type === 'error') mark(MARK.error, ev.error?.message || 'unknown');
}
function anthropicError(status, j) {
  const msg = j?.error?.message || `AI request failed (${status}).`;
  if (status === 401) return { code: 'bad_key', message: 'The Anthropic API key was rejected. Check it in .env and restart the server.' };
  if (status === 429) return { code: 'rate_limited', retryAfter: 10, message: msg };
  if (status === 529) return { code: 'overloaded', retryAfter: 10, message: msg };
  return { code: 'upstream', message: msg };
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const block = allowed(req);
    if (block) return send(res, 403, { message: block });
    if (p === '/api/health') return send(res, 200, { ai: !!AI.key, provider: PROVIDER_ID, providerName: AI.name, models: MODELS, concurrency: AI.concurrency });
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, { docs: Object.values(db) });
    const m = p.match(/^\/api\/doc\/([^/]+)$/);
    if (m) {
      let id; try { id = decodeURIComponent(m[1]); } catch { id = ''; }
      if (!ID_RE.test(id)) return send(res, 400, { message: 'Bad id' });
      if (req.method === 'PUT') {
        const doc = await readBody(req, 4 * 1024 * 1024);
        if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.kind !== 'string') return send(res, 400, { message: 'A document must be an object with a kind' });
        db[id] = { ...doc, id }; await persist(); return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') { delete db[id]; await persist(); return send(res, 200, { ok: true }); }
      return send(res, 405, { message: 'Method not allowed' });
    }
    if (p === '/api/ai' && req.method === 'POST') return await handleAI(req, res);
    if (p.startsWith('/api/')) return send(res, 404, { message: 'Not found' });
    if (req.method === 'GET' || req.method === 'HEAD') {
      let rel; try { rel = decodeURIComponent(p === '/' ? '/index.html' : p); } catch { return send(res, 400, 'Bad path', 'text/plain'); }
      const file = path.normalize(path.join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
      fs.readFile(file, (err, data) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream'));
      return;
    }
    send(res, 404, { message: 'Not found' });
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { message: err.status ? err.message : 'Server error' }); else res.end();
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Study Hub running at http://${LOCAL_ONLY || HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (!LOCAL_ONLY) console.log('Warning: HOST is not localhost. Anyone who can reach this machine can read your data and use your API key. There is no login.');
    console.log(AI.key ? `AI: ${AI.name} (${MODELS.default})` : 'AI is off: get a free key at https://aistudio.google.com/apikey and add GEMINI_API_KEY=... to .env, then restart.');
  });
}
module.exports = { server };
