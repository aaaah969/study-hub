// Checks small helpers from public/index.html that handle AI replies (no browser, no network).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const code = html.split('\n').filter(l => /^const (TEX_ESC|fixTexEsc|fixBadEsc|mathWrap)=|^function parseJSON\(/.test(l)).join('\n');
const { parseJSON, mathWrap } = new Function(code + '\nreturn { parseJSON, mathWrap };')();

test('LaTeX written with one backslash in JSON keeps its letters', () => {
  const raw = String.raw`{"a":"angle $\theta < 15^\circ$","b":"$\frac{1}{2}kA^2$","c":"\omega = \sqrt{k/m}","d":"ok $\\beta$","e":"line1\nline2"}`;
  const j = parseJSON(raw);
  assert.equal(j.a, String.raw`angle $\theta < 15^\circ$`);
  assert.equal(j.b, String.raw`$\frac{1}{2}kA^2$`);
  assert.equal(j.c, String.raw`\omega = \sqrt{k/m}`);
  assert.equal(j.d, String.raw`ok $\beta$`);
  assert.equal(j.e, 'line1\nline2');
});

test('parseJSON still reads fenced replies and rejects garbage', () => {
  assert.deepEqual(parseJSON('```json\n{"x":1}\n```'), { x: 1 });
  assert.deepEqual(parseJSON('Here you go: {"x":2} thanks'), { x: 2 });
  assert.throws(() => parseJSON('no json here'), e => e.code === 'bad_json');
});

test('bare LaTeX formulas get $ delimiters, others are left alone', () => {
  assert.equal(mathWrap(String.raw`Angular frequency: \omega = \sqrt{\frac{k}{m}}`), String.raw`Angular frequency: $\omega = \sqrt{\frac{k}{m}}$`);
  assert.equal(mathWrap(String.raw`\tau = r \times F`), String.raw`$\tau = r \times F$`);
  assert.equal(mathWrap('Hooke: $F=-kx$'), 'Hooke: $F=-kx$');
  assert.equal(mathWrap('Energy is conserved'), 'Energy is conserved');
});
