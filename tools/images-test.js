// Checks src/images.js: counting images in a transcript and the space they take.
// Run with: node tools/images-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { imagesOf, idle } = require('../src/images');

const MB = 1024 * 1024;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-images-'));
const image = (bytes, extra = '') => `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(bytes) } }] } })}${extra}\n`;
const text = (words) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: `say "type":"image" ${'word '.repeat(words)}` } })}\n`;
const count = async (file) => {
  const size = fs.statSync(file).size;
  imagesOf(file, size);
  await idle();
  return imagesOf(file, size);
};

(async () => {
  const file = path.join(dir, 'chat.jsonl');

  // No images. Text that merely mentions an image does not count: its quotes are escaped.
  fs.writeFileSync(file, text(2000));
  assert.strictEqual(imagesOf(file, fs.statSync(file).size), null, 'nothing known before the first count');
  assert.deepStrictEqual(await count(file), { count: 0, bytes: 0 });

  // Small and large images, one bigger than the pieces the file is read in, and enough
  // text between them for marks to land on the edge of a piece.
  const sizes = [1000, 5 * MB, 300000, 9 * MB + 123, 42, 2 * MB];
  let body = '';
  for (const bytes of sizes) body += text(Math.round(bytes / 100)) + image(bytes);
  fs.appendFileSync(file, body);
  const all = sizes.reduce((a, b) => a + b, 0);
  assert.deepStrictEqual(await count(file), { count: sizes.length, bytes: all });

  // Only what is added gets counted again.
  fs.appendFileSync(file, text(50) + image(777) + image(1234));
  assert.deepStrictEqual(await count(file), { count: sizes.length + 2, bytes: all + 777 + 1234 });

  // A mark with no data after it does not count: it is a mention of an image (what a
  // tool was asked for, an image passed by its address), with nothing of it in the file.
  fs.appendFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }, { type: 'text', text: 'x'.repeat(2000) }] } })}\n`);
  assert.deepStrictEqual(await count(file), { count: sizes.length + 2, bytes: all + 777 + 1234 });

  // An image a tool returned is on its line twice: in the message, and in the copy of the
  // tool's result that follows. It is one image; both copies take up room in the file.
  // The line after it starts afresh.
  const shot = (bytes) => `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(bytes) } }] }] },
    toolUseResult: { content: [{ type: 'image', file: { base64: 'B'.repeat(bytes) } }] },
  })}\n`;
  fs.appendFileSync(file, shot(500) + image(60) + shot(5 * MB));
  assert.deepStrictEqual(await count(file), { count: sizes.length + 5, bytes: all + 777 + 1234 + 1000 + 60 + 10 * MB });

  // A line still being written is left for the next count, when all of it is there.
  const whole = image(90);
  fs.appendFileSync(file, whole.slice(0, 70));
  assert.deepStrictEqual(await count(file), { count: sizes.length + 5, bytes: all + 777 + 1234 + 1000 + 60 + 10 * MB });
  fs.appendFileSync(file, whole.slice(70));
  assert.deepStrictEqual(await count(file), { count: sizes.length + 6, bytes: all + 777 + 1234 + 1000 + 60 + 10 * MB + 90 });

  // A file that shrank (rewritten) is counted from the start.
  fs.writeFileSync(file, image(10) + text(5));
  assert.deepStrictEqual(await count(file), { count: 1, bytes: 10 });

  // Marks placed exactly around the edge of a piece (4 MB).
  for (const shift of [-20, -14, -13, -1, 0, 1, 7, 13, 14, 395, 400]) {
    const edge = path.join(dir, `edge${shift}.jsonl`);
    const first = image(50);
    const pad = 4 * MB + shift - Buffer.byteLength(first) - 60;
    fs.writeFileSync(edge, first + 'x'.repeat(pad) + '\n' + image(3000) + image(8));
    assert.deepStrictEqual(await count(edge), { count: 3, bytes: 3058 }, `edge shift ${shift}`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('images.js: all cases passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
