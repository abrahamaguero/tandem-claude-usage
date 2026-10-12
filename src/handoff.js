// Reads the local Claude Code chats: lists the recent ones, with what each is costing, and
// builds the "continue this work" prompt of one of them.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { imagesOf } = require('./images');

const MB = 1024 * 1024;
// How much of one transcript is read at a time. A chat with many images runs to hundreds
// of megabytes, so a bigger one is read in two pieces: its start, which has the folder it
// began in and its first request, and its end, which has what is going on now.
const WHOLE = { head: 2 * MB, tail: 38 * MB };
// Enough for the list of chats, which is rebuilt every minute.
const GLANCE = { head: 1 * MB, tail: 4 * MB };

// Where Claude Code keeps its chats: its own folder, which CLAUDE_CONFIG_DIR may move.
const ROOT = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

function readSlice(file, start, length) {
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    return buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, length, start));
  } finally {
    fs.closeSync(fd);
  }
}

// The lines of a transcript, or of its start and its end when it is bigger than `head`
// and `tail` together. `partial` says which, and `gap` is then the index of the first
// line that comes from the end.
function transcriptLines(file, size, { head, tail }) {
  let span = tail;
  for (;;) {
    if (head + span >= size) return { lines: fs.readFileSync(file, 'utf8').split('\n'), partial: false, gap: -1 };
    const last = readSlice(file, size - span, span).split('\n');
    last.shift(); // cut mid-line
    // One entry holding an image can be bigger than the piece read; widen it until it
    // shows an entry with a time, which is what says when the chat was last used.
    if (dated(last) || span >= WHOLE.tail) {
      const first = head ? readSlice(file, 0, head).split('\n') : [];
      first.pop(); // cut mid-line
      return { lines: first.concat(last), partial: true, gap: first.length };
    }
    span = Math.min(span * 4, WHOLE.tail);
  }
}

// Whether some entry among these lines says when it was written. The words alone do not
// tell: an entry without a time of its own may carry others' inside it. So the lines that
// have them are read, from the last one back, until one does.
function dated(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"timestamp":"')) continue;
    try {
      if (JSON.parse(lines[i]).timestamp) return true;
    } catch {}
  }
  return false;
}

// Transcripts whose file changed since the given time, newest first. Ids are
// "<project dir>/<file>". A file also changes when the Claude app merely opens the chat,
// so this is only a first cut; `usedAt` says when a chat was really used.
function recentTranscripts(sinceMs) {
  const found = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return found;
  }
  for (const dir of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(ROOT, dir.name)).filter((f) => f.endsWith('.jsonl'));
    } catch {}
    for (const file of files) {
      try {
        const { mtimeMs, size } = fs.statSync(path.join(ROOT, dir.name, file));
        if (mtimeMs >= sinceMs) found.push({ id: `${dir.name}/${file}`, mtimeMs, size });
      } catch {}
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

let glances = new Map(); // transcript id -> { mtimeMs, size, session }

// A transcript read just enough to list it, and read again only when its file changes.
function glance(id, mtimeMs, size, keep) {
  let hit = glances.get(id);
  if (!hit || hit.mtimeMs !== mtimeMs || hit.size !== size) {
    try {
      hit = { mtimeMs, size, session: readSession(path.join(ROOT, id), GLANCE) };
    } catch {
      return null;
    }
  }
  keep.set(id, hit);
  return hit.session;
}

// Chats used in the last `hours`, the most recently used first.
function listSessions(hours) {
  const since = Date.now() - hours * 3600 * 1000;
  const sessions = [];
  const keep = new Map();
  for (const { id, mtimeMs, size } of recentTranscripts(since)) {
    const s = glance(id, mtimeMs, size, keep);
    if (!s || s.usedAt < since) continue;
    // A chat nobody has written in yet is not listed. One read in part may simply have its messages further back.
    if (!s.userMessages.length && !s.partial) continue;
    const first = s.userMessages.length ? clip(s.userMessages[0], 60) : '';
    // `titled` is false when the "title" is just the start of the first message.
    sessions.push({
      id, usedAt: s.usedAt, project: projectName(s), root: s.root, title: s.title || first, titled: Boolean(s.title),
      context: s.context, perMessage: s.perMessage, cacheUntil: s.cacheUntil, cacheMinutes: s.cacheMinutes,
      startContext: s.startContext, model: s.model,
      // Counted in the background over the whole file; null until the first count is in.
      images: imagesOf(path.join(ROOT, id), size), size,
    });
  }
  glances = keep;
  return sessions.sort((a, b) => b.usedAt - a.usedAt);
}

function projectName(session) {
  return session.cwd ? path.basename(session.cwd) : session.title || '';
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

// Cut by whole characters: an emoji is two units of a string, and half of one is garbage.
function clip(text, max) {
  const clean = [...text.trim()];
  return clean.length > max ? `${clean.slice(0, max).join('').trimEnd()}…` : clean.join('');
}

// What Claude Code itself writes in the user's name: the wrappers of commands, reminders
// and tool output (tags like <command-name> or <system-reminder>, whose names have a
// hyphen or an underscore, unlike the HTML someone may paste), and its note for a reply
// that was cut short.
const HARNESS = /^(<[a-z]+[-_][a-z_-]*[\s>]|\[Request interrupted)/;

// What the user's latest messages cost, on average: how many requests ("steps") each one
// took and how many tokens those requests handled in all. Every step sends the whole
// chat again, so this grows with the chat. Null when no message was seen whole.
function messageCost(turns) {
  const done = turns.filter((turn) => turn.steps > 0).slice(-5);
  if (!done.length) return null;
  const mean = (key) => Math.round(done.reduce((sum, turn) => sum + turn[key], 0) / done.length);
  return { tokens: mean('tokens'), steps: mean('steps'), count: done.length };
}

function readSession(file, limits = WHOLE) {
  const { lines, partial, gap } = transcriptLines(file, fs.statSync(file).size, limits);
  // `root` is where the chat was started; `cwd` follows it if it moves into another folder.
  // `usedAt` is the time of its last dated entry: the file's own date does not say when the
  // chat was used, because the Claude app also writes undated notes to it on opening it.
  // `context` is the size of the conversation, in tokens, as of its latest reply.
  // `cacheUntil` is when the cached copy of the chat expires: it lasts a set time after
  // the latest reply, and until then sending the chat again costs a fraction.
  // `startContext` is the size of the chat at its first reply: what is loaded before the
  // user writes (tools, skills, instructions) plus the first message. Zero if that reply
  // is not in the part read. `model` is the one that gave the latest reply.
  const session = { cwd: null, root: null, branch: null, title: null, userMessages: [], lastReply: '', files: [], usedAt: 0, context: 0, startContext: 0, model: null, perMessage: null, cacheUntil: 0, cacheMinutes: 0, partial };
  let turns = []; // one per message the user typed: { steps, tokens }
  const counted = new Set(); // a reply is logged once per content block; count it once
  let repliedAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Past the gap, the steps seen first belong to a message that began in the part skipped.
    if (i === gap) turns = [];
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const time = (entry.timestamp && Date.parse(entry.timestamp)) || 0;
    if (time > session.usedAt) session.usedAt = time;
    if (entry.isSidechain) continue;
    if (entry.cwd) session.cwd = entry.cwd;
    if (entry.cwd && !session.root) session.root = entry.cwd;
    if (entry.gitBranch && entry.gitBranch !== 'HEAD') session.branch = entry.gitBranch;
    if (entry.type === 'custom-title' && entry.customTitle) session.title = entry.customTitle;
    const message = entry.message;
    if (!message) continue;
    // The summary a compaction leaves in place of the chat is written as if by the user.
    if (entry.type === 'user' && !entry.isMeta && !entry.isCompactSummary) {
      const text = textOf(message.content).trim();
      if (text && !HARNESS.test(text)) {
        session.userMessages.push(text);
        turns.push({ steps: 0, tokens: 0 });
      }
    } else if (entry.type === 'assistant' && Array.isArray(message.content)) {
      // A notice the app writes itself when a request fails (a limit reached, an error)
      // looks like a reply, with a made-up model in angle brackets and no tokens. It is not
      // the chat's last reply, and it says nothing of the chat's size or of its cache.
      if (typeof message.model === 'string' && message.model.startsWith('<')) continue;
      const u = message.usage;
      if (u) {
        const sent = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        session.context = sent;
        if (!session.startContext && (gap < 0 || i < gap)) session.startContext = sent;
        if (message.model) session.model = message.model;
        if (message.id && !counted.has(message.id)) {
          counted.add(message.id);
          if (time > repliedAt) repliedAt = time;
          // The reply says how long the cache it wrote is kept.
          const kept = u.cache_creation || {};
          if (kept.ephemeral_1h_input_tokens) session.cacheMinutes = 60;
          else if (kept.ephemeral_5m_input_tokens) session.cacheMinutes = 5;
          const turn = turns[turns.length - 1];
          if (turn) {
            turn.steps++;
            turn.tokens += sent + (u.output_tokens || 0);
          }
        }
      }
      const text = textOf(message.content).trim();
      if (text) session.lastReply = text;
      for (const part of message.content) {
        const target = part.type === 'tool_use' && ['Edit', 'Write', 'NotebookEdit'].includes(part.name) && part.input && (part.input.file_path || part.input.notebook_path);
        if (!target) continue;
        session.files = session.files.filter((f) => f !== target);
        session.files.push(target);
      }
    }
  }
  session.perMessage = messageCost(turns);
  if (repliedAt && session.cacheMinutes) session.cacheUntil = repliedAt + session.cacheMinutes * 60000;
  return session;
}

const TEXT = {
  en: {
    intro: 'I am continuing work that I started in another Claude session, which ran out of usage. Pick it up where it left off.',
    folder: 'Project folder',
    branch: 'Git branch',
    topic: 'Session title',
    first: 'Original request',
    recent: 'My most recent messages (oldest first)',
    last: "Where the previous session left off (its last reply)",
    files: 'Files it edited most recently',
    outro: 'Start by reading the relevant files to get up to speed, then continue with the pending work. Ask me if anything is unclear.',
  },
  es: {
    intro: 'Estoy continuando un trabajo que empecé en otra sesión de Claude, que se quedó sin uso. Retómalo donde se quedó.',
    folder: 'Carpeta del proyecto',
    branch: 'Rama de Git',
    topic: 'Título de la sesión',
    first: 'Petición original',
    recent: 'Mis mensajes más recientes (del más antiguo al más nuevo)',
    last: 'Dónde se quedó la sesión anterior (su última respuesta)',
    files: 'Archivos que editó más recientemente',
    outro: 'Empieza leyendo los archivos relevantes para ponerte al día y luego continúa con lo pendiente. Pregúntame si algo no queda claro.',
  },
};

// `appTitle` is the chat's current name in the Claude app, when it is known.
function buildHandoff(language, id, appTitle) {
  // Ids come from the renderer, so only accept the exact shape listSessions() produces.
  if (!/^[^\\/]+\/[^\\/]+\.jsonl$/.test(id) || id.includes('..')) return null;
  let s;
  try {
    s = readSession(path.join(ROOT, id));
  } catch {
    return null;
  }
  if (!s.userMessages.length) return null;
  if (appTitle) s.title = appTitle;
  const L = TEXT[language] || TEXT.en;
  const recent = s.userMessages.slice(1).slice(-5);
  const parts = [L.intro, ''];
  if (s.cwd) parts.push(`${L.folder}: ${s.cwd}`);
  if (s.branch) parts.push(`${L.branch}: ${s.branch}`);
  if (s.title) parts.push(`${L.topic}: ${s.title}`);
  parts.push('', `${L.first}:`, clip(s.userMessages[0], 1500));
  if (recent.length) parts.push('', `${L.recent}:`, ...recent.map((m, i) => `${i + 1}. ${clip(m, 600)}`));
  if (s.lastReply) parts.push('', `${L.last}:`, clip(s.lastReply, 2000));
  if (s.files.length) parts.push('', `${L.files}:`, ...s.files.slice(-15).map((f) => `- ${f}`));
  parts.push('', L.outro);
  return { prompt: parts.join('\n'), project: projectName(s), title: s.title || clip(s.userMessages[0], 60) };
}

module.exports = { buildHandoff, listSessions, recentTranscripts, transcriptLines, readSession, ROOT, MB, GLANCE };
