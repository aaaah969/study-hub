// Study Hub server: serves the app, stores your data in data/db.json,
// and forwards AI requests to the Anthropic API using your own key.
// No dependencies: needs Node 18 or newer.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODELS = {
  quick: process.env.MODEL_QUICK || 'claude-haiku-5-5',
  default: process.env.MODEL_DEFAULT || 'claude-sonnet-5-5',
  complex: process.env.MODEL_COMPLEX || 'claude-opus-5-5',
};
// These models think before they answer, and thinking counts toward max_tokens,
// so the limits are generous. Replies are streamed, so long ones do not time out.
const MAX_TOKENS = { quick: 16000, default: 32000, complex: 64000 };
const EFFORT = { quick: 'low', default: 'medium', complex: 'high' };
// Server-side refusal fallback (beta). Haiku has none, so it is only sent for the other tiers.
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

// ---------- AI: Anthropic Messages API with streaming ----------
async function handleAI(req, res) {
  if (!KEY) return send(res, 400, { code: 'no_key', message: 'Add ANTHROPIC_API_KEY to the .env file and restart the server.' });
  const body = await readBody(req);
  const tier = MODELS[body.tier] ? body.tier : 'default';
  let messages = Array.isArray(body.messages) ? body.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()) : [];
  if (!messages.length || messages[0].role !== 'user' || messages[messages.length - 1].role !== 'user') return send(res, 400, { code: 'invalid', message: 'Messages must start and end with a user message.' });
  messages = messages.map(m => ({ role: m.role, content: m.content }));
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter(i => i && /^image\/(jpeg|png|webp|gif)$/.test(i.media_type) && typeof i.data === 'string' && i.data.length)
    .slice(0, 8);
  if (images.length) {
    const last = messages[messages.length - 1];
    last.content = [
      ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })),
      { type: 'text', text: last.content },
    ];
  }

  // Stop the upstream request if the browser goes away, so no tokens are wasted.
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });

  const payload = { model: MODELS[tier], max_tokens: MAX_TOKENS[tier], stream: true, output_config: { effort: EFFORT[tier] }, messages };
  const headers = { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' };
  if (USE_FALLBACK[tier] && process.env.DISABLE_FALLBACK !== '1') { payload.fallbacks = 'default'; headers['anthropic-beta'] = FALLBACK_BETA; }

  let upstream;
  try {
    upstream = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal,
    });
  } catch (err) {
    if (ctrl.signal.aborted) return;
    return send(res, 502, { code: 'network', message: 'Could not reach the AI service. Check your internet connection.' });
  }
  if (!upstream.ok) {
    let msg = 'AI request failed (' + upstream.status + ').';
    try { const j = await upstream.json(); msg = j.error?.message || msg; } catch {}
    const code = upstream.status === 429 ? 'rate_limited' : upstream.status === 401 ? 'bad_key' : upstream.status === 529 ? 'overloaded' : 'upstream';
    if (code === 'bad_key') msg = 'The API key in .env was rejected. Check it and restart the server.';
    return send(res, upstream.status === 429 || upstream.status === 529 ? 429 : 502, { code, message: msg });
  }

  // Re-stream only the text as plain chunks, plus a marker if the reply was cut short.
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  const reader = upstream.body.getReader(); const dec = new TextDecoder(); let buf = '';
  const handle = line => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    let ev; try { ev = JSON.parse(line.slice(5)); } catch { return; }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') res.write(ev.delta.text);
    else if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'max_tokens') res.write(MARK.cut);
    else if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'refusal') res.write(MARK.refusal);
    else if (ev.type === 'error') res.write(MARK.error + ' ' + String(ev.error?.message || 'unknown').replace(/\s+/g, ' '));
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
    if (!ctrl.signal.aborted) res.write(MARK.error + ' The connection to the AI service dropped.');
  }
  res.end();
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const block = allowed(req);
    if (block) return send(res, 403, { message: block });
    if (p === '/api/health') return send(res, 200, { ai: !!KEY, models: MODELS });
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
    if (!KEY) console.log('Note: no ANTHROPIC_API_KEY set. AI features are off until you add it to .env');
  });
}
module.exports = { server };
