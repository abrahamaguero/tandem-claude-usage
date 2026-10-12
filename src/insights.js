// Usage history (for projections and sparklines) and token statistics from local Claude Code logs.
const fs = require('fs');
const path = require('path');
const { ROOT, MB, recentTranscripts } = require('./handoff');
const { readJson, writeJson } = require('./store');

const DAY = 24 * 3600 * 1000;

// ---------- usage history ----------

// Samples are [timestamp, { metricId: pct }], kept for 24 h per account.
function createHistory(file) {
  const data = readJson(file) || {};
  return {
    add(key, metrics) {
      if (!data[key]) data[key] = [];
      data[key].push([Date.now(), Object.fromEntries(metrics.map((m) => [m.id, m.pct]))]);
    },
    save() {
      const cutoff = Date.now() - DAY;
      for (const key of Object.keys(data)) {
        data[key] = data[key].filter((s) => s[0] >= cutoff);
        if (!data[key].length) delete data[key];
      }
      writeJson(file, data);
    },
    series(key, metricId, sinceMs) {
      return (data[key] || []).filter((s) => s[0] >= sinceMs && metricId in s[1]).map((s) => [s[0], s[1][metricId]]);
    },
  };
}

// When the limit would hit 100% at the pace seen in `series`, or null if it will not
// happen before the limit resets (or there is not enough data to tell).
function projectFull(series, resetsAt, minSpanMs) {
  // Only the stretch after the last reset says anything about the current pace.
  let start = 0;
  for (let i = 1; i < series.length; i++) {
    if (series[i][1] < series[i - 1][1]) start = i;
  }
  const run = series.slice(start);
  if (run.length < 2) return null;
  const [t0, p0] = run[0];
  const [t1, p1] = run[run.length - 1];
  if (t1 - t0 < minSpanMs || p1 <= p0 || p1 >= 100) return null;
  const fullAt = t1 + ((100 - p1) * (t1 - t0)) / (p1 - p0);
  if (resetsAt && fullAt >= new Date(resetsAt).getTime()) return null;
  return Math.round(fullAt);
}

// How fast a limit has been filling lately, in points per millisecond: the pace of the
// stretch since its last reset. Zero when it is flat or there is too little to tell.
function recentRate(series, minSpanMs) {
  let start = 0;
  for (let i = 1; i < series.length; i++) {
    if (series[i][1] < series[i - 1][1]) start = i;
  }
  const run = series.slice(start);
  if (run.length < 2) return 0;
  const [t0, p0] = run[0];
  const [t1, p1] = run[run.length - 1];
  return t1 - t0 < minSpanMs || p1 <= p0 ? 0 : (p1 - p0) / (t1 - t0);
}

function downsample(series, max) {
  if (series.length <= max) return series;
  const step = series.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(series[Math.floor(i * step)]);
  out.push(series[series.length - 1]);
  return out;
}

// ---------- token statistics ----------

// What is kept of each transcript read: how far it has been read (`from`..`to`, in bytes)
// and what was found. A transcript is read from its end backwards, a stretch at a time,
// until what is read is older than the day being counted; from then on, only what gets
// added to it is read. That way a chat of hundreds of megabytes is counted in full for
// the day without being read whole.
const fileCache = new Map(); // file -> { mtimeMs, size, from, to, cwd, title, usedAt, context, contextAt, messages }

const STRETCH = 8 * MB; // read at a time
const DEEPEST = 192 * MB; // how far back a first reading may go
const ADDED = 64 * MB; // more than this added at once is read as a new file
const HUGE = 512 * 1024; // a line this long holds an image or a file: only its time is taken
const NEWLINE = 0x0a;

function readBytes(file, start, length) {
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, start));
  } finally {
    fs.closeSync(fd);
  }
}

// Takes in a run of whole lines. `older` says they come from before what was already
// read, so they only fill in what is still missing. Returns the earliest time in them.
function absorb(chat, text, older) {
  let earliest = 0;
  let title = null;
  let cwd = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry = null;
    if (line.length > HUGE) {
      const at = line.indexOf('"timestamp":"');
      if (at >= 0) entry = { timestamp: line.slice(at + 13, line.indexOf('"', at + 13)) };
    } else {
      try {
        entry = JSON.parse(line);
      } catch {}
    }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.cwd && !cwd) cwd = entry.cwd;
    if (entry.type === 'custom-title' && entry.customTitle) title = entry.customTitle;
    // Only dated entries count as use: the Claude app also writes undated notes when it opens a chat.
    const time = (entry.timestamp && Date.parse(entry.timestamp)) || 0;
    if (!time) continue;
    if (time > chat.usedAt) chat.usedAt = time;
    if (!earliest || time < earliest) earliest = time;
    const message = entry.message;
    if (entry.type !== 'assistant' || !message || !message.usage || !message.id) continue;
    // A notice the app writes itself when a request fails (a limit reached, an error) looks
    // like a reply with no tokens in it. It is not one, and must not pass for the chat's size.
    const model = String(message.model || '');
    if (model.startsWith('<')) continue;
    const u = message.usage;
    // A reply is logged once per content block with the same usage, so keep one row per message id.
    // Cache reads are left out: they are re-sent context, not new work.
    chat.messages.set(message.id, [time, model, (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0)]);
    // Everything sent with the latest main-thread request is the size of the conversation's context.
    if (!entry.isSidechain && time >= chat.contextAt) {
      chat.contextAt = time;
      chat.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
  }
  // The folder is the one the chat started in, and the title the last one it was given.
  if (cwd && (older || !chat.cwd)) chat.cwd = cwd;
  if (title && !(older && chat.title)) chat.title = title;
  return earliest;
}

// A first reading: backwards from the end until the lines are older than `since`.
function readBack(file, size, since) {
  const chat = { from: size, to: size, cwd: null, title: null, usedAt: 0, context: 0, contextAt: 0, messages: new Map() };
  let end = size;
  let whole = false; // whether `end` falls on the start of a line
  let latest = true; // nothing has been taken in yet: what comes first is the latest
  while (end > 0 && size - end < DEEPEST) {
    const start = Math.max(0, end - STRETCH);
    const piece = readBytes(file, start, end - start);
    // The piece begins mid-line unless it begins the file, and may end mid-line too: at
    // the end of the file, when a line is still being written, or after a line too long
    // to fit a stretch.
    const first = start ? piece.indexOf(NEWLINE) + 1 : 0;
    const last = whole ? piece.length : piece.lastIndexOf(NEWLINE) + 1;
    if (start && !first) {
      // No line ends in this piece: it is all one image. Nothing to take from it.
      end = start;
      whole = false;
      continue;
    }
    // What comes after the last whole line is read next time, once it is whole.
    if (latest) chat.to = start + last;
    const earliest = last > first ? absorb(chat, piece.toString('utf8', first, last), !latest) : 0;
    latest = false;
    end = start + first;
    whole = true;
    chat.from = end;
    if (earliest && earliest < since) break;
  }
  return chat;
}

// The replies of a transcript since `since` and what else the statistics need of it,
// reading only what changed since the last time. Null when it cannot be read.
function readChat(file, mtimeMs, size, since) {
  let chat = fileCache.get(file);
  if (chat && chat.mtimeMs === mtimeMs && chat.size === size) return chat;
  try {
    if (chat && size >= chat.to && size - chat.to <= ADDED) {
      // Only what was added, up to its last whole line.
      const piece = readBytes(file, chat.to, size - chat.to);
      const last = piece.lastIndexOf(NEWLINE) + 1;
      if (last) absorb(chat, piece.toString('utf8', 0, last), false);
      chat.to += last;
    } else {
      chat = readBack(file, size, since);
    }
  } catch {
    return null;
  }
  chat.mtimeMs = mtimeMs;
  chat.size = size;
  fileCache.set(file, chat);
  return chat;
}

// The transcripts of the sub-agents a chat started, which are files of their own in a
// folder named after the chat. What they spend is part of what the chat spent.
function subagentsOf(file, since) {
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          const { mtimeMs, size } = fs.statSync(full);
          if (mtimeMs >= since) found.push({ file: full, mtimeMs, size });
        } catch {}
      }
    }
  };
  walk(path.join(file.slice(0, -'.jsonl'.length), 'subagents'), 0);
  return found;
}

function modelName(id) {
  // The id may carry a date or a note after the version: claude-opus-4-7-20260101, claude-opus-4-7[1m].
  const match = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|\[|$)/.exec(id);
  if (!match) return id || '?';
  const family = match[1][0].toUpperCase() + match[1].slice(1);
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
}

// Token totals for the last 24 h, split by account. The logs do not record which account
// paid for a message, so ownerAt(time) says which account was active at that moment.
// nameOf(id, chat) gives the name each chat goes by.
function tokenStats(ownerAt, nameOf) {
  const since = Date.now() - DAY;
  const buckets = new Map();
  const live = new Set();
  const contexts = [];
  // A reply is counted once, wherever it turns up again: a chat forked or resumed copies
  // the earlier ones into its new file, under the same ids.
  const counted = new Set();
  const add = (map, name, tokens) => map.set(name, (map.get(name) || 0) + tokens);
  for (const { id, mtimeMs, size } of recentTranscripts(since)) {
    const file = path.join(ROOT, id);
    live.add(file);
    const chat = readChat(file, mtimeMs, size, since);
    // Its file changed, but the chat itself was not used.
    if (!chat || chat.usedAt < since) continue;
    const parts = [chat];
    for (const sub of subagentsOf(file, since)) {
      live.add(sub.file);
      const part = readChat(sub.file, sub.mtimeMs, sub.size, since);
      if (part) parts.push(part);
    }
    const name = nameOf(id, { project: chat.cwd ? path.basename(chat.cwd) : path.basename(path.dirname(file)), title: chat.title });
    // Every account that was in use while this chat was active in the last 24 h.
    const owners = new Set();
    for (const part of parts) {
      for (const [reply, [time, model, tokens]] of part.messages) {
        if (time < since) {
          part.messages.delete(reply); // too old to count again
          continue;
        }
        if (!tokens || counted.has(reply)) continue;
        counted.add(reply);
        const owner = ownerAt(time);
        owners.add(owner);
        if (!buckets.has(owner)) buckets.set(owner, { total: 0, projects: new Map(), models: new Map() });
        const bucket = buckets.get(owner);
        bucket.total += tokens;
        add(bucket.projects, name, tokens);
        add(bucket.models, modelName(model), tokens);
      }
    }
    if (!owners.size) owners.add(ownerAt(chat.usedAt));
    contexts.push({ id, usedAt: chat.usedAt, name, context: chat.context, owners: [...owners] });
  }
  for (const file of fileCache.keys()) {
    if (!live.has(file)) fileCache.delete(file);
  }
  const top = (map) => [...map].map(([name, tokens]) => ({ name, tokens })).sort((a, b) => b.tokens - a.tokens).slice(0, 6);
  const byAccount = {};
  for (const [owner, bucket] of buckets) {
    byAccount[owner] = { total: bucket.total, projects: top(bucket.projects), models: top(bucket.models) };
  }
  return { byAccount, contexts };
}

function contextOf(id) {
  const chat = fileCache.get(path.join(ROOT, id));
  return chat ? chat.context : 0;
}

module.exports = { createHistory, projectFull, recentRate, downsample, tokenStats, contextOf, modelName };
