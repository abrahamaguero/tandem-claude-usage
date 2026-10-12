// Checks src/claude-app.js against files shaped like the Claude desktop app's.
// Run with: node tools/claude-app-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { appSessions, chatSetup } = require('../src/claude-app');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-claude-app-'));
const org = path.join(root, 'account-1', 'org-1');
fs.mkdirSync(org, { recursive: true });

// Same key order as the app writes, with the bulky fields after the ones that matter.
const session = (over) => JSON.stringify({
  sessionId: 'local_x', cliSessionId: 'chat-1', cwd: 'E:\\work\\repo\\qa', originCwd: 'E:\\work\\repo',
  gitAnchors: { gitRoot: 'E:\\work\\repo' }, lastActivityAt: 1, model: 'm', isArchived: false,
  title: 'First name', titleSource: 'user', enabledMcpTools: { a: true }, promptAppendSnapshot: { append: 'x'.repeat(300000), title: 'not this one' },
  ...over,
});
const write = (name, body, mtime) => {
  const file = path.join(org, name);
  fs.writeFileSync(file, body);
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
};

// The file name does not have to match the chat; the title and the starting folder are read.
const first = write('local_aaa.json', session({}));
let names = appSessions(root);
assert.deepStrictEqual({ ...names.get('chat-1'), mtimeMs: 0 }, { title: 'First name', folder: 'E:\\work\\repo', file: first, mtimeMs: 0 });

// Renamed in the app: the new title shows up.
write('local_aaa.json', session({ title: 'Renamed "chat" — ñ' }), new Date(Date.now() + 5000));
names = appSessions(root);
assert.strictEqual(names.get('chat-1').title, 'Renamed "chat" — ñ');

// Other chats, including one without a title and one with only a current folder.
write('local_bbb.json', session({ cliSessionId: 'chat-2', title: undefined }));
write('local_ccc.json', session({ cliSessionId: 'chat-3', originCwd: undefined, title: 'Third' }));
names = appSessions(root);
assert.strictEqual(names.get('chat-2').title, null);
assert.strictEqual(names.get('chat-3').folder, 'E:\\work\\repo\\qa');

// Files that are not chats are ignored, and so is a damaged one.
write('archived-sessions.idx', '{"v":1,"archived":["local_aaa"]}');
write('deleted_chat-9', '1791687667720');
write('local_ddd.json', '{"sessionId":"local_d","cliSess');
write('local_eee.json', JSON.stringify({ sessionId: 'local_e', title: 'No transcript yet' }));
names = appSessions(root);
assert.deepStrictEqual([...names.keys()].sort(), ['chat-1', 'chat-2', 'chat-3']);

// The same chat on file twice: the file written last is the current one.
write('local_fff.json', session({ title: 'Newest copy' }), new Date(Date.now() + 60000));
assert.strictEqual(appSessions(root).get('chat-1').title, 'Newest copy');

// A deleted chat disappears.
fs.rmSync(path.join(org, 'local_fff.json'));
fs.rmSync(first);
assert.strictEqual(appSessions(root).has('chat-1'), false);

// No such folder (the Claude app is not installed).
assert.strictEqual(appSessions(path.join(root, 'missing')).size, 0);

// How a chat is set up: model, effort, and the tools switched on, per connector by name.
const setupFile = write('local_setup.json', JSON.stringify({
  sessionId: 'local_s', cliSessionId: 'chat-s', cwd: 'E:\\work', model: 'claude-opus-5-5', effort: 'xhigh', sessionSettings: { ultracode: true },
  enabledMcpTools: { 'u-1:send': true, 'u-1:read': true, 'u-1:delete': false, 'u-2:query': true, 'local:run': true },
  remoteMcpServersConfig: [{ uuid: 'u-1', name: 'Mail', tools: [{ name: 'send' }] }, { uuid: 'u-2', name: 'Data' }],
}));
assert.strictEqual(appSessions(root).get('chat-s').file, setupFile);
assert.deepStrictEqual(chatSetup(setupFile), {
  model: 'claude-opus-5-5', effort: 'xhigh', ultracode: true, tools: 4,
  connectors: [{ name: 'Mail', tools: 2 }, { name: 'Data', tools: 1 }, { name: 'local', tools: 1 }],
});
// A chat with nothing set, and a file that is not there.
assert.deepStrictEqual(chatSetup(write('local_bare.json', JSON.stringify({ sessionId: 'local_b', cliSessionId: 'chat-b' }))),
  { model: null, effort: null, ultracode: false, tools: 0, connectors: [] });
assert.strictEqual(chatSetup(path.join(org, 'local_missing.json')), null);

fs.rmSync(root, { recursive: true, force: true });
console.log('claude-app.js: all cases passed');
