// Checks how src/handoff.js reads a transcript: when a chat was really used, and that a
// transcript too big to read whole still gives its folder, size and last use.
// Run with: node tools/handoff-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { readSession, GLANCE, MB } = require('../src/handoff');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-handoff-'));
const line = (o) => `${JSON.stringify(o)}\n`;
const user = (text, at, cwd = 'E:\\work\\repo') => line({ type: 'user', cwd, timestamp: at, message: { role: 'user', content: text } });
const reply = (text, at, tokens, id = `m${at}`, cache = {}) => line({
  type: 'assistant', cwd: 'E:\\work\\repo\\qa', timestamp: at,
  message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: tokens, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 5, cache_creation: cache } },
});
const when = (iso) => Date.parse(iso);

// 1. Last used in July; in October the Claude app opened it and wrote an undated note.
const old = path.join(dir, 'old.jsonl');
fs.writeFileSync(old, user('first request', '2026-07-29T10:00:00.000Z') + reply('done', '2026-07-30T18:54:00.000Z', 500)
  + line({ type: 'last-prompt', lastPrompt: 'x' }) + line({ type: 'cost-state', cost: 1 }));
fs.utimesSync(old, new Date('2026-10-10T22:19:00Z'), new Date('2026-10-10T22:19:00Z'));
let s = readSession(old);
assert.strictEqual(s.usedAt, when('2026-07-30T18:54:00.000Z'), 'the file date is not the last use');
assert.strictEqual(s.partial, false);
assert.strictEqual(s.root, 'E:\\work\\repo');
assert.strictEqual(s.cwd, 'E:\\work\\repo\\qa');
assert.strictEqual(s.context, 1500);
assert.strictEqual(s.startContext, 1500, 'size at the first reply');
assert.strictEqual(s.model, 'claude-opus-5-5');
assert.deepStrictEqual(s.userMessages, ['first request']);

// 2. Bigger than a glance reads: the start and the end are enough.
const big = path.join(dir, 'big.jsonl');
const filler = reply('x'.repeat(64 * 1024), '2026-10-01T00:00:00.000Z', 10);
fs.writeFileSync(big, user('start here', '2026-09-30T09:00:00.000Z') + line({ type: 'custom-title', customTitle: 'Named early' }));
// About 8 MB in the middle: 128 steps of the first message.
for (let i = 0; i < 128; i++) fs.appendFileSync(big, reply('x'.repeat(64 * 1024), '2026-10-01T00:00:00.000Z', 10, `step-${i}`));
fs.appendFileSync(big, user('latest question', '2026-10-11T23:50:00.000Z') + reply('latest answer', '2026-10-11T23:56:00.000Z', 400000));
assert.ok(fs.statSync(big).size > GLANCE.head + GLANCE.tail);
s = readSession(big, GLANCE);
assert.strictEqual(s.partial, true);
assert.strictEqual(s.usedAt, when('2026-10-11T23:56:00.000Z'));
assert.strictEqual(s.root, 'E:\\work\\repo', 'folder comes from the start');
assert.strictEqual(s.title, 'Named early');
assert.strictEqual(s.context, 401000);
assert.strictEqual(s.userMessages[0], 'start here');
assert.strictEqual(s.userMessages[s.userMessages.length - 1], 'latest question');
assert.strictEqual(s.lastReply, 'latest answer');
// The first message's steps are cut by the gap, so only the latest message is costed.
assert.deepStrictEqual(s.perMessage, { tokens: 401005, steps: 1, count: 1 });
// The size at the first reply comes from the start, not from the latest replies.
assert.strictEqual(s.startContext, 1010);
// Read whole, it says the same about what matters.
const whole = readSession(big);
assert.strictEqual(whole.partial, false);
assert.strictEqual(whole.usedAt, s.usedAt);
assert.strictEqual(whole.context, s.context);
assert.strictEqual(whole.perMessage.count, 2);
assert.strictEqual(whole.perMessage.steps, Math.round((128 + 1) / 2));

// 3. The last entry holds an image bigger than the piece read: the piece widens to reach a dated entry.
const image = path.join(dir, 'image.jsonl');
fs.writeFileSync(image, user('look at this', '2026-10-05T08:00:00.000Z'));
for (let i = 0; i < 12; i++) fs.appendFileSync(image, filler.repeat(8)); // about 6 MB
fs.appendFileSync(image, reply('before the image', '2026-10-09T12:00:00.000Z', 900));
fs.appendFileSync(image, line({ type: 'attachment', attachment: { data: 'A'.repeat(6 * MB) } })); // undated, 6 MB
s = readSession(image, GLANCE);
assert.strictEqual(s.usedAt, when('2026-10-09T12:00:00.000Z'));
assert.strictEqual(s.context, 1900);

// 4. Only the tail, as when asking just for the last use.
s = readSession(big, { head: 0, tail: MB / 4 });
assert.strictEqual(s.usedAt, when('2026-10-11T23:56:00.000Z'));
assert.strictEqual(s.startContext, 0, 'the first reply is not in the part read');

// 5. Cost per message and cache. A reply logged twice (one line per content block) is one
// step; steps before the first typed message belong to nothing.
const chat = path.join(dir, 'chat.jsonl');
fs.writeFileSync(chat,
  reply('orphan', '2026-10-11T09:59:00.000Z', 100, 'r0')
  + user('first', '2026-10-11T10:00:00.000Z')
  + reply('thinking', '2026-10-11T10:00:05.000Z', 9000, 'r1') + reply('thinking, second block', '2026-10-11T10:00:05.000Z', 9000, 'r1')
  + reply('tool call', '2026-10-11T10:00:20.000Z', 9500, 'r2', { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 })
  + line({ type: 'user', timestamp: '2026-10-11T10:00:21.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } })
  + user('second', '2026-10-11T10:05:00.000Z')
  + reply('answer', '2026-10-11T10:05:30.000Z', 19000, 'r3', { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 70 }));
s = readSession(chat);
// first: (9000 + 1000 + 5) + (9500 + 1000 + 5) = 20510 in 2 steps; second: 20005 in 1 step.
assert.deepStrictEqual(s.perMessage, { tokens: Math.round((20510 + 20005) / 2), steps: 2, count: 2 });
assert.strictEqual(s.cacheMinutes, 60, 'the latest reply that wrote to the cache says how long it lasts');
assert.strictEqual(s.cacheUntil, when('2026-10-11T11:05:30.000Z'));

// A chat that only ever used the short cache.
const short = path.join(dir, 'short.jsonl');
fs.writeFileSync(short, user('hi', '2026-10-11T10:00:00.000Z') + reply('hello', '2026-10-11T10:00:05.000Z', 50, 'r1', { ephemeral_5m_input_tokens: 9, ephemeral_1h_input_tokens: 0 }));
s = readSession(short);
assert.strictEqual(s.cacheUntil, when('2026-10-11T10:05:05.000Z'));

// Nothing typed yet, or no reply yet: no cost and no cache to speak of.
const empty = path.join(dir, 'empty.jsonl');
fs.writeFileSync(empty, user('hi', '2026-10-11T10:00:00.000Z'));
s = readSession(empty);
assert.strictEqual(s.perMessage, null);
assert.strictEqual(s.cacheUntil, 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log('handoff.js: all cases passed');
