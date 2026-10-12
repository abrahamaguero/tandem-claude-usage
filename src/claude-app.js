// The names the Claude desktop app gives its Code chats. It keeps one file per chat with
// the current title and folder; a transcript only records the title the chat got first,
// so a chat renamed in the app would keep showing its old name.
const fs = require('fs');
const path = require('path');

// The fields wanted sit at the start of each file; the rest is large and of no use here.
const HEAD = 8192;
let cache = new Map(); // file -> { mtimeMs, size, info }
let last = { root: null, at: 0, found: new Map() };

function field(head, key) {
  const match = head.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

function readInfo(file) {
  const buffer = Buffer.alloc(HEAD);
  const fd = fs.openSync(file, 'r');
  let length;
  try {
    length = fs.readSync(fd, buffer, 0, HEAD, 0);
  } finally {
    fs.closeSync(fd);
  }
  const head = buffer.toString('utf8', 0, length);
  const id = field(head, 'cliSessionId');
  return id ? { id, title: field(head, 'title'), folder: field(head, 'originCwd') || field(head, 'cwd') } : null;
}

function sessionFiles(dir, depth = 0) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {}
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return depth < 3 ? sessionFiles(full, depth + 1) : [];
    return /^local_.*\.json$/.test(entry.name) ? [full] : [];
  });
}

// Transcript name (the .jsonl file without its extension) -> { title, folder }, for every
// chat under `root`, the app's claude-code-sessions folder. Files are read again only
// when they change, and a result younger than `maxAgeMs` is reused as it is: with a
// thousand chats on file, just checking them all for changes takes a moment.
function appSessions(root, maxAgeMs = 0) {
  if (last.root === root && Date.now() - last.at < maxAgeMs) return last.found;
  const found = new Map();
  const seen = new Map();
  for (const file of sessionFiles(root)) {
    try {
      const { mtimeMs, size } = fs.statSync(file);
      let hit = cache.get(file);
      if (!hit || hit.mtimeMs !== mtimeMs || hit.size !== size) hit = { mtimeMs, size, info: readInfo(file) };
      seen.set(file, hit);
      if (!hit.info) continue;
      // The same chat can be on file twice; the one written last is the current one.
      const other = found.get(hit.info.id);
      if (!other || other.mtimeMs < mtimeMs) found.set(hit.info.id, { title: hit.info.title, folder: hit.info.folder, file, mtimeMs });
    } catch {}
  }
  cache = seen;
  last = { root, at: Date.now(), found };
  return found;
}

const setups = new Map(); // file -> { mtimeMs, size, setup }

// How a chat is set up in the app: its model and effort, and the tools it loads from
// connectors, most tools first. Read from the chat's whole file, so only worth asking
// for the few chats on show. Null if the file cannot be read.
function chatSetup(file) {
  try {
    const { mtimeMs, size } = fs.statSync(file);
    const hit = setups.get(file);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.setup;
    const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
    const names = new Map((Array.isArray(chat.remoteMcpServersConfig) ? chat.remoteMcpServersConfig : []).map((server) => [server.uuid, server.name]));
    const counts = new Map();
    for (const [key, on] of Object.entries(chat.enabledMcpTools || {})) {
      if (on !== true) continue;
      // Keys are "<connector id>:<tool>"; "local" is every server set up on this computer.
      const id = key.slice(0, key.indexOf(':'));
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    const connectors = [...counts].map(([id, tools]) => ({ name: names.get(id) || id, tools })).sort((a, b) => b.tools - a.tools);
    const setup = {
      model: chat.model || null,
      effort: chat.effort || null,
      ultracode: Boolean(chat.sessionSettings && chat.sessionSettings.ultracode),
      tools: connectors.reduce((sum, c) => sum + c.tools, 0),
      connectors,
    };
    setups.set(file, { mtimeMs, size, setup });
    return setup;
  } catch {
    return null;
  }
}

module.exports = { appSessions, chatSetup };
