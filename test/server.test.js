// Run with: npm test   (Node's built-in test runner, no packages needed)
// Starts the real server against a fake Anthropic API, so no key or credits are used.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let fake, fakeURL, srv, base, dataDir, lastUpstream, nextReply;

// Tests must never see a real API key: drop any from the environment, and compare keys
// without printing them, so a failing check cannot leak one into a log.
const CLEAN_ENV = { ...process.env };
for (const k of ['ANTHROPIC_API_KEY', 'STUDYHUB_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AI_PROVIDER']) delete CLEAN_ENV[k];
const sentKey = k => assert.ok(lastUpstream.headers['x-api-key'] === k, 'the server did not send the expected test key (value not shown)');

const sse = events => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const textReply = (text, stop = 'end_turn') => sse([
  { type: 'message_start', message: { id: 'm1' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret' } },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  ...text.match(/.{1,5}/gs).map(t => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } })),
  { type: 'message_delta', delta: { stop_reason: stop } },
  { type: 'message_stop' },
]);

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request(u, { method, headers: { ...(data && !headers['content-type'] ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: out, json: () => JSON.parse(out) }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

before(async () => {
  fake = http.createServer((q, s) => {
    let b = ''; q.on('data', c => b += c); q.on('end', () => {
      lastUpstream = { headers: q.headers, body: JSON.parse(b) };
      const r = nextReply || { status: 200, body: textReply('Hello there') }; nextReply = null;
      s.writeHead(r.status, { 'content-type': r.status === 200 ? 'text/event-stream' : 'application/json' }); s.end(r.body);
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  fakeURL = 'http://127.0.0.1:' + fake.address().port;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-test-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  base = 'http://localhost:' + port;
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...CLEAN_ENV, PORT: String(port), DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: fakeURL, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => { srv.stdout.on('data', d => { if (String(d).includes('running')) resolve(); }); srv.on('exit', c => reject(new Error('server exited ' + c))); });
});
after(() => { srv?.kill(); fake?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('health reports AI on and the models', async () => {
  const r = await req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json().ai, true);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('documents can be saved, listed and deleted, and are written to disk', async () => {
  assert.equal((await req('PUT', '/api/doc/c1', { body: { kind: 'course', name: 'Physics' } })).status, 200);
  let docs = (await req('GET', '/api/state')).json().docs;
  assert.deepEqual(docs.find(d => d.id === 'c1'), { kind: 'course', name: 'Physics', id: 'c1' });
  assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')).c1);
  assert.equal((await req('DELETE', '/api/doc/c1')).status, 200);
  docs = (await req('GET', '/api/state')).json().docs;
  assert.equal(docs.find(d => d.id === 'c1'), undefined);
});

test('bad ids and bad documents are rejected', async () => {
  assert.equal((await req('PUT', '/api/doc/a.b', { body: { kind: 'x' } })).status, 400);
  assert.equal((await req('PUT', '/api/doc/ok', { body: [1, 2] })).status, 400);
  assert.equal((await req('PUT', '/api/doc/ok', { body: { name: 'no kind' } })).status, 400);
  assert.equal((await req('PUT', '/api/doc/ok', { body: '{not json' })).status, 400);
});

test('other websites cannot use the API (CSRF and DNS rebinding)', async () => {
  // A cross-site form or no-cors fetch can only send text/plain: it must be refused.
  assert.equal((await req('POST', '/api/ai', { body: '{}', headers: { 'content-type': 'text/plain' } })).status, 403);
  assert.equal((await req('PUT', '/api/doc/x', { body: { kind: 'course' }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await req('GET', '/api/state', { headers: { host: 'evil.example:3000' } })).status, 403);
  assert.equal((await req('DELETE', '/api/doc/x', { headers: { origin: 'null' } })).status, 403);
  // Same-origin requests from the app itself still work.
  assert.equal((await req('PUT', '/api/doc/x', { body: { kind: 'course' }, headers: { origin: base } })).status, 200);
});

test('static files are served and path traversal is blocked', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>Study Hub<\/title>/);
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/%2e%2e%2f.env']) {
    assert.notEqual((await req('GET', p)).status, 200, p);
  }
});

test('AI replies stream as plain text, without the thinking', async () => {
  nextReply = { status: 200, body: textReply('The answer is 42.') };
  const r = await req('POST', '/api/ai', { body: { messages: [{ role: 'user', content: 'hi' }], tier: 'complex' } });
  assert.equal(r.status, 200);
  assert.equal(r.text, 'The answer is 42.');
  const b = lastUpstream.body;
  assert.equal(b.model, 'claude-opus-5-5');
  assert.equal(b.stream, true);
  assert.equal(b.max_tokens, 64000);
  assert.deepEqual(b.output_config, { effort: 'high' });
  assert.equal(b.fallbacks, 'default');
  assert.equal(lastUpstream.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  sentKey('test-key');
});

test('quick tier uses Haiku without the fallback beta', async () => {
  await req('POST', '/api/ai', { body: { messages: [{ role: 'user', content: 'hi' }], tier: 'quick' } });
  assert.equal(lastUpstream.body.model, 'claude-haiku-5-5');
  assert.equal(lastUpstream.body.fallbacks, undefined);
  assert.equal(lastUpstream.headers['anthropic-beta'], undefined);
});

test('a cut-off reply carries a marker the app can detect', async () => {
  nextReply = { status: 200, body: textReply('{"questions":[', 'max_tokens') };
  const r = await req('POST', '/api/ai', { body: { messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r.text, '{"questions":[\n[[studyhub:cut_off]]');
});

test('images are attached to the last user message; bad ones are dropped', async () => {
  await req('POST', '/api/ai', { body: { messages: [{ role: 'user', content: 'read this' }], images: [{ media_type: 'image/jpeg', data: 'QUJD' }, { media_type: 'text/html', data: 'x' }] } });
  const c = lastUpstream.body.messages[0].content;
  assert.equal(c.length, 2);
  assert.equal(c[0].type, 'image');
  assert.deepEqual(c[1], { type: 'text', text: 'read this' });
});

test('invalid conversations and upstream errors give clear errors', async () => {
  assert.equal((await req('POST', '/api/ai', { body: { messages: [{ role: 'assistant', content: 'x' }] } })).status, 400);
  nextReply = { status: 429, body: JSON.stringify({ error: { message: 'slow down' } }) };
  let r = await req('POST', '/api/ai', { body: { messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 429); assert.equal(r.json().code, 'rate_limited');
  nextReply = { status: 401, body: JSON.stringify({ error: { message: 'invalid x-api-key' } }) };
  r = await req('POST', '/api/ai', { body: { messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 502); assert.equal(r.json().code, 'bad_key');
});

test('STUDYHUB_API_KEY is accepted as the key', async () => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const env = { ...CLEAN_ENV, PORT: String(port), DATA_DIR: dataDir, STUDYHUB_API_KEY: 'alt-key', ANTHROPIC_BASE_URL: fakeURL };
  const s2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise(r => s2.stdout.on('data', d => String(d).includes('running') && r()));
    const r = await new Promise((resolve, reject) => {
      const q = http.request('http://localhost:' + port + '/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' } }, res => { let o = ''; res.on('data', c => o += c); res.on('end', () => resolve({ status: res.statusCode })); });
      q.on('error', reject); q.end(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
    });
    assert.equal(r.status, 200);
    sentKey('alt-key');
  } finally { s2.kill(); }
});
