// Sets up graphify (the knowledge-graph skill for Claude Code) in a project folder by
// running its command-line tool. Nothing here calls a model, so it costs no usage.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// What the user pastes in a chat to build the full graph (docs, images, relationships).
const FULL_GRAPH_COMMAND = '/graphify .';
const TIMEOUT = 10 * 60 * 1000;
const busy = new Set(); // folders being set up right now, as keyOf() names them

const graphFile = (dir) => path.join(dir, 'graphify-out', 'graph.json');
// One name per folder, however it is written: Windows does not tell E:\App from e:\app\.
const keyOf = (dir) => path.resolve(dir).toLowerCase();
const WINDOWS = process.platform === 'win32';

// Where the tool is, as a full path, or null when it is not installed. It is looked for
// in the folders its installers use and in the PATH, and never run by its bare name:
// Windows looks for a bare name first in the folder the command runs in, which here is
// somebody's project, and would run whatever "graphify.exe" is lying there.
function executable() {
  const name = WINDOWS ? 'graphify.exe' : 'graphify';
  // uv and pipx put it in ~/.local/bin; "pip install --user", under %APPDATA%\Python.
  const dirs = [path.join(os.homedir(), '.local', 'bin')];
  if (WINDOWS && process.env.APPDATA) {
    const python = path.join(process.env.APPDATA, 'Python');
    try {
      for (const version of fs.readdirSync(python)) dirs.push(path.join(python, version, 'Scripts'));
    } catch {}
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (path.isAbsolute(dir)) dirs.push(dir);
  }
  for (const dir of dirs) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch {}
  }
  return null;
}

// A project that has a file of its own called graphify is left alone. The tool finds
// itself by name when it writes its hook into the project, looking first in the folder it
// runs in: it would take that file for itself and tell Claude Code to run it.
function hasImpostor(dir) {
  try {
    return fs.readdirSync(dir).some((name) => /^graphify(\.(exe|com|bat|cmd|ps1))?$/i.test(name) && !fs.statSync(path.join(dir, name)).isDirectory());
  } catch {
    return false;
  }
}

const logName = (id) => `tandem-graphify-${id}.log`;

// A run leaves its log behind when Tandem is closed before it ends. Old ones are cleared.
function sweepLogs() {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!/^tandem-graphify-.*\.log$/.test(name)) continue;
      const file = path.join(os.tmpdir(), name);
      if (Date.now() - fs.statSync(file).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(file);
    }
  } catch {}
}
sweepLogs();

let runs = 0;

// Runs the tool on its own, writing to a file instead of a pipe back to Tandem. Closing
// Tandem midway (installing an update does that) then leaves the build running; with a
// pipe, the tool dies at its next line of output and the graph is never written.
function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const tool = executable();
    if (!tool) return reject(Object.assign(new Error('graphify is not installed'), { code: 'ENOENT' }));
    const log = path.join(os.tmpdir(), logName(`${process.pid}-${++runs}`));
    const out = fs.openSync(log, 'w');
    // The setting keeps Windows, and the tool itself where it honors it, from looking for
    // programs in the project's folder.
    const env = { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' };
    const child = spawn(tool, args, { cwd, env, windowsHide: true, detached: true, stdio: ['ignore', out, out] });
    fs.closeSync(out);
    const timer = setTimeout(() => child.kill(), TIMEOUT);
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let output = '';
      try {
        output = fs.readFileSync(log, 'utf8');
        fs.unlinkSync(log);
      } catch {}
      if (err) reject(Object.assign(err, { output }));
      else resolve();
    };
    child.on('error', finish);
    child.on('exit', (code) => finish(code === 0 ? null : new Error(`graphify ended with code ${code}`)));
  });
}

// Whether a folder is a project to put a graph in. The top of a drive, the home folder and
// the folders above it, Claude Code's own folder, and the big personal folders (Desktop,
// Documents, Downloads, a OneDrive) are not: there is no project to index there, scanning
// them would take forever, and graphify's notes would land in files meant for everything.
function isProject(dir) {
  let full;
  try {
    if (!dir || !fs.statSync(dir).isDirectory()) return false;
    full = fs.realpathSync(dir);
  } catch {
    return false;
  }
  const home = os.homedir();
  // Whether `inner` is `outer` itself or somewhere inside it.
  const within = (outer, inner) => {
    const rest = path.relative(outer, inner);
    return !rest.startsWith('..') && !path.isAbsolute(rest);
  };
  if (keyOf(full) === keyOf(path.parse(full).root)) return false;
  if (within(full, home) || within(path.join(home, '.claude'), full)) return false;
  const personal = path.relative(home, full);
  return !(/^(desktop|documents|downloads|onedrive[^\\/]*)$/i.test(personal));
}

// What is already in place: the section graphify writes in CLAUDE.md, and the graph.
function status(dir) {
  if (!isProject(dir)) return null;
  let enabled = false;
  try {
    enabled = /^## graphify\s*$/m.test(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'));
  } catch {}
  const graph = fs.existsSync(graphFile(dir));
  // A build made inside a chat, with documents and images, logs its cost; one made here
  // from the code alone does not. `full` says the complete graph is already there.
  const full = graph && fs.existsSync(path.join(dir, 'graphify-out', 'cost.json'));
  return { enabled, graph, full, busy: busy.has(keyOf(dir)) };
}

function lastLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] || '').slice(0, 200);
}

// Does one thing to a project, one at a time per folder, and puts what went wrong into
// the words the app has for it: 'folder', 'unsafe', 'busy', 'missing' or 'failed'.
async function inProject(dir, work) {
  if (!isProject(dir)) return { ok: false, error: 'folder' };
  if (hasImpostor(dir)) return { ok: false, error: 'unsafe' };
  const key = keyOf(dir);
  if (busy.has(key)) return { ok: false, error: 'busy' };
  busy.add(key);
  try {
    return await work();
  } catch (err) {
    return err.code === 'ENOENT' ? { ok: false, error: 'missing' } : { ok: false, error: 'failed', detail: lastLine(err.output || err.message) };
  } finally {
    busy.delete(key);
  }
}

// Turns graphify on for the project and, when it has no graph yet, builds one from the
// code alone. Without a graph at the end, `reason` says why: 'nocode' when the project has
// no code to graph (its graph has to come from FULL_GRAPH_COMMAND), 'failed' otherwise.
// Doing it again on a project that is on but has no graph tries the build again.
function setup(dir) {
  return inProject(dir, async () => {
    await run(['claude', 'install'], dir);
    let output = '';
    if (!fs.existsSync(graphFile(dir))) {
      try {
        await run(['extract', '.', '--code-only'], dir);
        // Writes GRAPH_REPORT.md and graph.html; --no-label keeps it from asking a model for names.
        await run(['cluster-only', '.', '--no-label'], dir);
      } catch (err) {
        output = err.output || err.message;
      }
    }
    if (fs.existsSync(graphFile(dir))) return { ok: true, graph: true };
    // "graph is empty" is what the tool says when the project has nothing it can graph.
    return /graph is empty/.test(output) ? { ok: true, graph: false, reason: 'nocode' } : { ok: true, graph: false, reason: 'failed', detail: lastLine(output) };
  });
}

// Undoes what turning it on did to the project: takes graphify's section out of CLAUDE.md
// and its hook out of .claude/settings.json. The graph stays where it is.
function turnOff(dir) {
  return inProject(dir, async () => {
    // --project is what keeps this to the project. Without it the tool also deletes the
    // skill installed for the whole user, from every project.
    await run(['claude', 'uninstall', '--project'], dir);
    return { ok: true };
  });
}

module.exports = { FULL_GRAPH_COMMAND, status, setup, turnOff };
