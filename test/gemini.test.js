// Gemini provider tests: the real server against a fake Gemini API (no key or quota used).
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let fake, srv, base, dataDir, last, nextReply;
// Never let a real key from the shell reach these tests.
const CLEAN_ENV = { ...process.env };
for (const k of ['ANTHROPIC_API_KEY', 'STUDYHUB_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AI_PROVIDER']) delete CLEAN_ENV[k];

const sse = chunks => chunks.map(c => `data: ${JSON.stringify(c)}\r\n\r\n`).join('');
const parts = (texts, finishReason) => sse(texts.map((t, i) => ({
  candidates: [{ content: { role: 'model', parts: Array.isArray(t) ? t : [{ text: t }] }, ...(i === texts.length - 1 && finishReason ? { finishReason } : {}) }],
})));

function post(body) {
  return new Promise((resolve, reject) => {
    const q = http.request(base + '/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let o = ''; res.on('data', c => o += c); res.on('end', () => resolve({ status: res.statusCode, text: o, json: () => JSON.parse(o) }));
    });
    q.on('error', reject); q.end(JSON.stringify(body));
  });
}
const hi = (tier) => post({ messages: [{ role: 'user', content: 'hi' }], ...(tier ? { tier } : {}) });

before(async () => {
  fake = http.createServer((q, s) => {
    let b = ''; q.on('data', c => b += c); q.on('end', () => {
      last = { url: q.url, headers: q.headers, body: JSON.parse(b) };
      const r = nextReply || { status: 200, body: parts(['Hello ', 'there'], 'STOP') }; nextReply = null;
      s.writeHead(r.status, { 'content-type': r.status === 200 ? 'text/event-stream' : 'application/json' }); s.end(r.body);
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-gemini-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  base = 'http://localhost:' + port;
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...CLEAN_ENV, PORT: String(port), DATA_DIR: dataDir, GEMINI_API_KEY: 'g-test-key', GEMINI_BASE_URL: 'http://127.0.0.1:' + fake.address().port },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => { srv.stdout.on('data', d => String(d).includes('running') && resolve()); srv.on('exit', c => reject(new Error('server exited ' + c))); });
});
after(() => { srv?.kill(); fake?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('Gemini is the provider when its key is set, with a lower concurrency', async () => {
  const h = await new Promise(r => http.get(base + '/api/health', res => { let o = ''; res.on('data', c => o += c); res.on('end', () => r(JSON.parse(o))); }));
  assert.equal(h.ai, true);
  assert.equal(h.provider, 'gemini');
  assert.equal(h.concurrency, 2);
  assert.equal(h.models.default, 'gemini-3.5-flash');
});

test('requests use the streaming endpoint, key header and Gemini message format', async () => {
  const r = await post({ messages: [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }], images: [{ media_type: 'image/png', data: 'QUJD' }], tier: 'quick' });
  assert.equal(r.status, 200);
  assert.equal(r.text, 'Hello there');
  assert.equal(last.url, '/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse');
  assert.ok(last.headers['x-goog-api-key'] === 'g-test-key', 'wrong key header (value not shown)');
  assert.deepEqual(last.body.contents.map(c => c.role), ['user', 'model', 'user']);
  assert.deepEqual(last.body.contents[2].parts, [{ inline_data: { mime_type: 'image/png', data: 'QUJD' } }, { text: 'Q2' }]);
  assert.equal(last.body.generationConfig.maxOutputTokens, 16384);
  assert.equal(last.body.fallbacks, undefined);
});

test('thought parts are not shown; text across chunks is joined', async () => {
  nextReply = { status: 200, body: parts([[{ text: 'secret plan', thought: true }], [{ text: '42' }], [{ text: ' is it' }]], 'STOP') };
  assert.equal((await hi()).text, '42 is it');
});

test('cut-off and blocked replies carry the markers the app reads', async () => {
  nextReply = { status: 200, body: parts(['{"questions":['], 'MAX_TOKENS') };
  assert.equal((await hi()).text, '{"questions":[\n[[studyhub:cut_off]]');
  nextReply = { status: 200, body: parts(['Partial'], 'SAFETY') };
  assert.equal((await hi()).text, 'Partial\n[[studyhub:refusal]]');
  nextReply = { status: 200, body: sse([{ promptFeedback: { blockReason: 'SAFETY' } }]) };
  assert.equal((await hi()).text, '\n[[studyhub:refusal]]');
});

test('rate limits pass on the retry delay; the daily limit is not retried', async () => {
  nextReply = { status: 429, body: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }] } }) };
  let r = await hi();
  assert.equal(r.status, 429); assert.equal(r.json().code, 'rate_limited'); assert.equal(r.json().retryAfter, 37);
  nextReply = { status: 429, body: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }) };
  r = await hi();
  assert.equal(r.json().code, 'quota_day');
});

test('a bad key and a retired model give clear messages', async () => {
  nextReply = { status: 400, body: JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } }) };
  let r = await hi();
  assert.equal(r.status, 502); assert.equal(r.json().code, 'bad_key'); assert.match(r.json().message, /GEMINI_API_KEY/);
  nextReply = { status: 404, body: JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'models/gemini-old is not found' } }) };
  r = await hi();
  assert.equal(r.json().code, 'bad_model'); assert.match(r.json().message, /GEMINI_MODEL_DEFAULT/);
});

test('without any key the AI is off with a setup message', async () => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const s2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...CLEAN_ENV, PORT: String(port), DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise(r => s2.stdout.on('data', d => String(d).includes('running') && r()));
    const r = await new Promise((resolve, reject) => {
      const q = http.request('http://localhost:' + port + '/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' } }, res => { let o = ''; res.on('data', c => o += c); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(o) })); });
      q.on('error', reject); q.end(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
    });
    assert.equal(r.status, 400); assert.equal(r.json.code, 'no_key'); assert.match(r.json.message, /aistudio\.google\.com/);
  } finally { s2.kill(); }
});
