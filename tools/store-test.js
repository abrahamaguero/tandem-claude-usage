// Checks src/store.js against the cases that matter when an update closes the app.
// Run with: node tools/store-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { readJson, writeJson } = require('../src/store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-store-'));
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// 1. First run: nothing on disk.
const a = path.join(dir, 'a.json');
assert.strictEqual(readJson(a), null);
writeJson(a, { v: 1 });
assert.deepStrictEqual(read(a), { v: 1 });
assert.ok(!fs.existsSync(`${a}.bak`), 'no backup on the first write');
assert.ok(!fs.existsSync(`${a}.tmp`), 'no temporary file left');

// 2. Later writes keep the version they replace.
writeJson(a, { v: 2 });
assert.deepStrictEqual(read(a), { v: 2 });
assert.deepStrictEqual(read(`${a}.bak`), { v: 1 });
assert.deepStrictEqual(readJson(a), { v: 2 });

// 3. Damaged file with a good backup: the backup is used and survives the next write.
const b = path.join(dir, 'b.json');
fs.writeFileSync(b, '{"profiles":[{"id":"p1","la');
fs.writeFileSync(`${b}.bak`, JSON.stringify({ profiles: ['p1'] }));
assert.deepStrictEqual(readJson(b), { profiles: ['p1'] });
writeJson(b, { profiles: ['p1'], more: true }, 2);
assert.deepStrictEqual(read(b), { profiles: ['p1'], more: true });
assert.deepStrictEqual(read(`${b}.bak`), { profiles: ['p1'] }, 'damaged file did not replace the backup');
writeJson(b, { profiles: ['p1', 'p2'] });
assert.deepStrictEqual(read(`${b}.bak`), { profiles: ['p1'], more: true });

// 4. Empty file (a write cut right at the start) with a good backup.
const c = path.join(dir, 'c.json');
fs.writeFileSync(c, '');
fs.writeFileSync(`${c}.bak`, '{"ok":true}');
assert.deepStrictEqual(readJson(c), { ok: true });

// 5. Damaged file and no backup.
const d = path.join(dir, 'd.json');
fs.writeFileSync(d, 'not json');
assert.strictEqual(readJson(d), null);

// 6. A leftover temporary file from an interrupted save does not get in the way.
const e = path.join(dir, 'e.json');
writeJson(e, { v: 1 });
fs.writeFileSync(`${e}.tmp`, '{"v":');
assert.deepStrictEqual(readJson(e), { v: 1 });
writeJson(e, { v: 2 });
assert.deepStrictEqual(read(e), { v: 2 });
assert.ok(!fs.existsSync(`${e}.tmp`));

fs.rmSync(dir, { recursive: true, force: true });
console.log('store.js: 6 cases passed');
