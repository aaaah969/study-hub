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
const MAX_TOKENS = { quick: 4000, default: 8000, complex: 16000 };
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC = path.join(ROOT, 'public');
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---------- storage: one JSON file, written atomically ----------
let db = {};
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = {}; }
let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain.then(async () => {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(db));
    await fs.promises.rename(tmp, DB_FILE);
  }).catch(err => console.error('Could not save data:', err.message));
  return writeChain;
}

// ---------- helpers ----------
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// ---------- AI: Anthropic Messages API with streaming ----------
async function handleAI(req, res) {
  if (!KEY) return send(res, 400, { code: 'no_key', message: 'Add ANTHROPIC_API_KEY to the .env file and restart the server.' });
  const body = await readBody(req);
  const tier = MODELS[body.tier] ? body.tier : 'default';
  let messages = Array.isArray(body.messages) ? body.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') : [];
  if (!messages.length || messages[messages.length - 1].role !== 'user') return send(res, 400, { code: 'invalid', message: 'Messages must end with a user message.' });
  messages = messages.map(m => ({ role: m.role, content: m.content }));
  const images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];
  if (images.length) {
    const last = messages[messages.length - 1];
    last.content = [
      ...images.filter(i => i && /^image\/(jpeg|png|webp|gif)$/.test(i.media_type) && typeof i.data === 'string')
        .map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })),
      { type: 'text', text: last.content },
    ];
  }
  const upstream = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODELS[tier], max_tokens: MAX_TOKENS[tier], stream: true, messages }),
  });
  if (!upstream.ok) {
    let msg = 'AI request failed (' + upstream.status + ').';
    try { const j = await upstream.json(); msg = j.error?.message || msg; } catch {}
    return send(res, upstream.status === 429 ? 429 : 502, { code: upstream.status === 429 ? 'rate_limited' : 'upstream', message: msg });
  }
  // Re-stream only the text as plain chunks.
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  const reader = upstream.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      try {
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') res.write(ev.delta.text);
        else if (ev.type === 'error') res.write('\n\n[AI error: ' + (ev.error?.message || 'unknown') + ']');
      } catch {}
    }
  }
  res.end();
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/api/health') return send(res, 200, { ai: !!KEY, models: MODELS });
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, { docs: Object.values(db) });
    const m = p.match(/^\/api\/doc\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (!ID_RE.test(id)) return send(res, 400, { message: 'Bad id' });
      if (req.method === 'PUT') { const doc = await readBody(req, 2 * 1024 * 1024); db[id] = { ...doc, id }; await persist(); return send(res, 200, { ok: true }); }
      if (req.method === 'DELETE') { delete db[id]; await persist(); return send(res, 200, { ok: true }); }
    }
    if (p === '/api/ai' && req.method === 'POST') return await handleAI(req, res);
    if (req.method === 'GET') {
      const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
      if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
      fs.readFile(file, (err, data) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream'));
      return;
    }
    send(res, 404, { message: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { message: err.message || 'Server error' }); else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Study Hub running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!KEY) console.log('Note: no ANTHROPIC_API_KEY set. AI features are off until you add it to .env');
});
