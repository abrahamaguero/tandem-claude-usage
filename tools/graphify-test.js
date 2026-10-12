// Checks src/graphify.js by running the real graphify tool in throwaway folders.
// Run with: node tools/graphify-test.js   (needs graphify installed: pip install graphifyy)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const graphify = require('../src/graphify');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-graphify-'));

  // Folders that are not a project.
  assert.strictEqual(graphify.status(null), null);
  assert.strictEqual(graphify.status(path.join(dir, 'missing')), null);
  assert.strictEqual(graphify.status(os.homedir()), null);
  assert.strictEqual(graphify.status(path.parse(dir).root), null);
  assert.deepStrictEqual(await graphify.setup(os.homedir()), { ok: false, error: 'folder' });

  // A project with code: turned on, and its graph built.
  const code = path.join(dir, 'code');
  fs.mkdirSync(path.join(code, 'src'), { recursive: true });
  fs.writeFileSync(path.join(code, 'src', 'a.js'), "const { helper } = require('./b');\nfunction main() { return helper(2); }\nmodule.exports = { main };\n");
  fs.writeFileSync(path.join(code, 'src', 'b.js'), 'function helper(x) { return x * 2; }\nmodule.exports = { helper };\n');
  assert.deepStrictEqual(graphify.status(code), { enabled: false, graph: false, full: false, busy: false });
  const running = graphify.setup(code);
  assert.strictEqual(graphify.status(code).busy, true);
  assert.deepStrictEqual(await graphify.setup(code), { ok: false, error: 'busy' });
  assert.deepStrictEqual(await running, { ok: true, graph: true });
  assert.deepStrictEqual(graphify.status(code), { enabled: true, graph: true, full: false, busy: false });
  assert.ok(fs.existsSync(path.join(code, '.claude', 'settings.json')), 'hook registered');
  assert.ok(fs.existsSync(path.join(code, 'graphify-out', 'GRAPH_REPORT.md')), 'report written');

  // Doing it again changes nothing and keeps the graph.
  const graphBefore = fs.readFileSync(path.join(code, 'graphify-out', 'graph.json'), 'utf8');
  assert.deepStrictEqual(await graphify.setup(code), { ok: true, graph: true });
  assert.strictEqual(fs.readFileSync(path.join(code, 'graphify-out', 'graph.json'), 'utf8'), graphBefore);

  // An existing CLAUDE.md keeps its own content.
  const notes = path.join(dir, 'notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, 'CLAUDE.md'), '# My project\n\nKeep this line.\n');
  fs.writeFileSync(path.join(notes, 'README.md'), '# Notes\n\nOnly documents here.\n');
  // No code to graph: still turned on, without a graph.
  assert.deepStrictEqual(await graphify.setup(notes), { ok: true, graph: false, reason: 'nocode' });
  assert.deepStrictEqual(graphify.status(notes), { enabled: true, graph: false, full: false, busy: false });
  assert.ok(fs.readFileSync(path.join(notes, 'CLAUDE.md'), 'utf8').includes('Keep this line.'));

  // A build made inside a chat logs its cost: that is the full graph.
  fs.writeFileSync(path.join(code, 'graphify-out', 'cost.json'), '{"runs":[]}');
  assert.strictEqual(graphify.status(code).full, true);

  // Turning it off takes the section and the hook out of the project, keeps the graph and
  // the project's own notes, and leaves alone the skill installed for the whole user.
  const userSkill = path.join(os.homedir(), '.claude', 'skills', 'graphify', 'SKILL.md');
  const skillBefore = fs.existsSync(userSkill) ? fs.statSync(userSkill).mtimeMs : null;
  assert.deepStrictEqual(await graphify.turnOff(os.homedir()), { ok: false, error: 'folder' });
  assert.deepStrictEqual(await graphify.turnOff(code), { ok: true });
  assert.deepStrictEqual(graphify.status(code), { enabled: false, graph: true, full: true, busy: false });
  assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(code, '.claude', 'settings.json'), 'utf8'))).includes('graphify'), 'hook removed');
  assert.deepStrictEqual(await graphify.turnOff(notes), { ok: true });
  const notesMd = fs.readFileSync(path.join(notes, 'CLAUDE.md'), 'utf8');
  assert.ok(notesMd.includes('Keep this line.') && !/^## graphify/m.test(notesMd));
  assert.strictEqual(fs.existsSync(userSkill) ? fs.statSync(userSkill).mtimeMs : null, skillBefore, 'user skill untouched');
  // Off twice is fine, and on again is instant because the graph is still there.
  assert.deepStrictEqual(await graphify.turnOff(code), { ok: true });
  assert.deepStrictEqual(await graphify.setup(code), { ok: true, graph: true });
  assert.strictEqual(graphify.status(code).enabled, true);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('graphify.js: all cases passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
