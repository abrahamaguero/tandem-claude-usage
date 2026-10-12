// How many images a chat holds and how much of its transcript they take up. Pasted
// screenshots and the ones Claude takes stay in the chat as base64 and are what makes a
// transcript run to hundreds of megabytes. Counting them means reading the whole file, so
// it is done in the background, once, and after that only for what has been added.
const fs = require('fs');

const MARK = Buffer.from('"type":"image"');
// Where the image itself starts: its base64 follows one of these, right after the mark.
const DATA = [Buffer.from('"data":"'), Buffer.from('"base64":"')];
// An image a tool returned is written twice on its line: once in the message, which is
// the one in the conversation, and once more in this copy of the tool's result. The copy
// takes room in the file but is not another image.
const COPY = Buffer.from('"toolUseResult":');
const QUOTE = 0x22;
const NEWLINE = 0x0a;
const CHUNK = 4 * 1024 * 1024;
// The image's data starts this close after the mark, or it is not embedded at all.
const NEAR = 400;
// The longest thing looked for that may be split between one piece read and the next.
const SEAM = Math.max(MARK.length, COPY.length) - 1;

const known = new Map(); // file -> { scanned, count, bytes }
const pending = new Map(); // file -> size to scan up to
let working = null; // promise of the scan in progress

// Where the nearest of the data keys starts and ends after `from`, if it is within reach.
function dataAfter(buf, from) {
  let best = null;
  for (const key of DATA) {
    const at = buf.indexOf(key, from);
    if (at >= 0 && at < from + NEAR && (!best || at < best.at)) best = { at, end: at + key.length };
  }
  return best;
}

// Adds to `total` the images found between two positions of a file, which must be the
// start of a line and the end of one. Returns where it stopped.
async function scan(file, from, to, total) {
  const handle = await fs.promises.open(file, 'r');
  try {
    let carry = Buffer.alloc(0);
    let inData = false;
    let inCopy = false; // past the tool's copy on this line
    for (let pos = from; pos < to;) {
      const length = Math.min(CHUNK, to - pos);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const last = pos >= to;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      carry = Buffer.alloc(0);
      let i = 0;
      while (i < buf.length) {
        if (inData) {
          // Base64 has no quotes in it, so the next one closes the image.
          const end = buf.indexOf(QUOTE, i);
          total.bytes += (end < 0 ? buf.length : end) - i;
          if (end < 0) break;
          inData = false;
          i = end + 1;
          continue;
        }
        const mark = buf.indexOf(MARK, i);
        // Up to the mark, or up to what might be the start of something split by the edge.
        const upTo = mark >= 0 ? mark : last ? buf.length : Math.max(i, buf.length - SEAM);
        // Whichever comes last before that says where on the line this is: a new line
        // starts afresh, and the copy lasts to the end of its line.
        const line = buf.lastIndexOf(NEWLINE, upTo - 1);
        const copy = buf.lastIndexOf(COPY, upTo - 1);
        if (line >= i && line > copy) inCopy = false;
        else if (copy >= i && copy + COPY.length <= upTo) inCopy = true;
        if (mark < 0) {
          carry = buf.subarray(upTo);
          break;
        }
        if (!last && mark + MARK.length + NEAR > buf.length) {
          // Too close to the edge to see its data: look again with the next piece.
          carry = buf.subarray(mark);
          break;
        }
        // A mark with no data after it is a mention of an image, not one.
        const data = dataAfter(buf, mark + MARK.length);
        if (!data) {
          i = mark + MARK.length;
          continue;
        }
        if (!inCopy) total.count++;
        inData = true;
        i = data.end;
      }
    }
  } finally {
    await handle.close();
  }
}

// The end of the last whole line before `size`: a line still being written is left for
// the next count, when all of it is there.
async function lastLineEnd(file, from, size) {
  const handle = await fs.promises.open(file, 'r');
  try {
    for (let end = size; end > from;) {
      const start = Math.max(from, end - 65536);
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      const at = chunk.lastIndexOf(NEWLINE);
      if (at >= 0) return start + at + 1;
      end = start;
    }
    return from;
  } finally {
    await handle.close();
  }
}

async function work() {
  while (pending.size) {
    const [file, size] = pending.entries().next().value;
    pending.delete(file);
    const before = known.get(file);
    // A file that only grew is counted from where the last count stopped.
    const total = before && size >= before.scanned ? { ...before } : { scanned: 0, count: 0, bytes: 0, size: 0 };
    try {
      const end = await lastLineEnd(file, total.scanned, size);
      await scan(file, total.scanned, end, total);
      total.scanned = end;
      total.size = size;
      known.set(file, total);
    } catch {}
  }
  working = null;
}

// The count so far for a transcript of the given size, or null while the first count is
// still running. Asking is what keeps it up to date.
function imagesOf(file, size) {
  const hit = known.get(file);
  if (!hit || hit.size !== size) {
    pending.set(file, size);
    if (!working) working = work();
  }
  return hit ? { count: hit.count, bytes: hit.bytes } : null;
}

// Resolves when nothing is left to count.
const idle = () => working || Promise.resolve();

module.exports = { imagesOf, idle };
