// First-run setup tests: pasting the Gemini key in the app, and starting twice.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLEAN_ENV = { ...process.env };
for (const k of ['ANTHROPIC_API_KEY', 'STUDYHUB_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AI_PROVIDER', 'OPEN_BROWSER']) delete CLEAN_ENV[k];
const GOOD = 'good-key-1234567890abcdefXYZ', BAD = 'bad-key-1234567890abcdefXYZ';
let fake, srv, port, base, dir, envFile, fakeURL, checks = 0;

function call(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const q = http.request(base + p, { method, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let o = ''; res.on('data', c => o += c); res.on('end', () => resolve({ status: res.statusCode, text: o, json: () => JSON.parse(o) }));
    });
    q.on('error', reject); q.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const start = (extra = {}) => {
  const s = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...CLEAN_ENV, PORT: String(port), DATA_DIR: path.join(dir, 'data'), ENV_FILE: envFile, GEMINI_BASE_URL: fakeURL, ...extra }, stdio: ['ignore', 'pipe', 'inherit'] });
  s.out = ''; s.stdout.on('data', d => s.out += d);
  return s;
};

before(async () => {
  // Fake Google: the model list accepts only GOOD; generate streams one word.
  fake = http.createServer((q, s) => {
    let b = ''; q.on('data', c => b += c); q.on('end', () => {
      const ok = q.headers['x-goog-api-key'] === GOOD;
      if (q.method === 'GET') { checks++; s.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' }); return s.end(ok ? '{"models":[]}' : '{"error":{"code":400,"message":"API key not valid."}}'); }
      s.writeHead(200, { 'content-type': 'text/event-stream' });
      s.end('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: ok ? 'working' : 'wrong key used' }] }, finishReason: 'STOP' }] }) + '\r\n\r\n');
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  fakeURL = 'http://127.0.0.1:' + fake.address().port;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-setup-'));
  envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, '# my settings\nPORT=3000\nGEMINI_API_KEY=\n# keep me\n');
  port = 30000 + Math.floor(Math.random() * 20000);
  base = 'http://localhost:' + port;
  srv = start();
  await new Promise(r => srv.stdout.on('data', () => srv.out.includes('running') && r()));
});
after(() => { srv?.kill(); fake?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('without a key the AI is off and setup is offered', async () => {
  const h = (await call('GET', '/api/health')).json();
  assert.equal(h.ai, false); assert.equal(h.canSetup, true);
  assert.match(srv.out, /paste a free Gemini key/);
});

test('setup refuses other websites, junk and keys Google rejects, and saves nothing', async () => {
  assert.equal((await call('POST', '/api/setup', { geminiKey: GOOD }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/setup', { geminiKey: 'short' })).json().code, 'bad_format');
  assert.equal((await call('POST', '/api/setup', { geminiKey: 'has spaces in it 1234567890' })).json().code, 'bad_format');
  const r = await call('POST', '/api/setup', { geminiKey: BAD });
  assert.equal(r.status, 400); assert.equal(r.json().code, 'bad_key');
  assert.ok(!r.text.includes(BAD), 'the key must not be echoed back');
  assert.ok(!fs.readFileSync(envFile, 'utf8').includes(BAD));
  assert.equal((await call('GET', '/api/health')).json().ai, false);
});

test('a good key is checked, saved to .env and used at once', async () => {
  const before = checks;
  const r = await call('POST', '/api/setup', { geminiKey: GOOD });
  assert.equal(r.status, 200); assert.ok(!r.text.includes(GOOD));
  assert.equal(checks, before + 1);
  const env = fs.readFileSync(envFile, 'utf8');
  assert.equal(env, '# my settings\nPORT=3000\nGEMINI_API_KEY=' + GOOD + '\n# keep me\n', 'other lines kept, empty key line replaced');
  if (process.platform !== 'win32') assert.equal(fs.statSync(envFile).mode & 0o077, 0, '.env readable only by its owner');
  assert.equal((await call('GET', '/api/health')).json().ai, true);
  const ai = await call('POST', '/api/ai', { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(ai.text, 'working');
  assert.ok(!(await call('GET', '/api/state')).text.includes(GOOD));
});

test('the saved key is used after a restart', async () => {
  srv.kill(); await new Promise(r => setTimeout(r, 200));
  srv = start();
  await new Promise(r => srv.stdout.on('data', () => srv.out.includes('running') && r()));
  assert.equal((await call('GET', '/api/health')).json().ai, true);
});

test('starting a second time does not crash: it reports the running app and exits', async () => {
  const second = start();
  const code = await new Promise(r => second.on('exit', r));
  assert.equal(code, 0);
  assert.match(second.out, /already running/);
});
