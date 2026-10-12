// Takes the README pictures from a running Tandem with made-up data in place of the
// user's: accounts, figures, chats and times are all invented here. Before each picture it
// checks that nothing of the real data is on screen.
// Usage: node readme-shots.mjs <port> <outdir>
import fs from 'node:fs';
import path from 'node:path';
const [port, outDir] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.url.includes('renderer/index.html'));
if (!page) { console.log('targets:', targets.map((t) => t.url)); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable');
const run = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// An earlier run may have left its made-up data in the page: wait for the app's own.
await run(`api.refresh(); 'asked'`);
for (let i = 0; i < 30 && await run(`state.accounts.some((a) => a.orgName === 'Max plan' || a.orgName === 'Team plan')`); i++) await wait(1000);
if (await run(`state.accounts.some((a) => a.orgName === 'Max plan' || a.orgName === 'Team plan')`)) { console.log('the real data did not come back'); process.exit(1); }

// What must never show: the real names, folders and addresses, read from the app itself
// and kept inside the page (they are not printed here).
await run(`(async () => {
  const real = new Set();
  const add = (text) => { if (typeof text === 'string' && text.trim().length > 3) real.add(text.trim().toLowerCase()); };
  for (const a of state.accounts) { add(a.orgName); if (a.label !== 'Personal') add(a.label); }
  for (const p of state.profiles) { add(p.label === 'Account 1' ? '' : p.label); for (const o of p.orgs || []) { add(o.name); add(o.alias); } }
  for (const c of await api.listSessions()) { add(c.name); add(c.title); add(c.project); add(c.root); }
  for (const c of state.stats.contexts) add(c.name);
  // Two of the user's own names are also what the app itself says: the example label the
  // settings suggest, and the app's title (a chat is named after this project's folder).
  for (const own of ['personal', 'tandem - claude usage']) real.delete(own);
  window.__real = [...real];
  window.__leaks = () => { const text = document.getElementById('app').innerText.toLowerCase(); return window.__real.filter((word) => text.includes(word)).length + (text.includes('@') ? 1 : 0); };
  return window.__real.length;
})()`);

// The made-up data. `what` is the view to leave on screen.
await run(`window.__demo = (what) => {
  const now = Date.now();
  const MIN = 60000, H = 3600000, D = 86400000;
  const iso = (ms) => new Date(ms).toISOString();
  const s = structuredClone(state);
  Object.assign(s.settings, { glass: false, language: 'en', warnAt: 75, critAt: 90, contextWarn: 500000 });
  s.update = { latest: null, checked: true };
  s.handoff = null;
  const [a, b] = s.accounts;
  s.accounts = [a, b].filter(Boolean);
  // Twelve hours of the session limit: one that filled up and reset, then the one under way.
  const spark = Array.from({ length: 90 }, (_, i) => {
    const at = i / 89;
    const pct = at < 0.32 ? 48 + at * 120 : at < 0.36 ? 0 : 38 * ((at - 0.36) / 0.64) ** 1.3;
    return [now - (1 - at) * 12 * H, Math.round(pct)];
  });
  Object.assign(a, {
    label: 'Personal', orgName: 'Max plan', status: 'ok', error: null, extra: null, spark, sessionCount: 3,
    metrics: [
      { id: 'five_hour', pct: 38, resetsAt: iso(now + 2 * H + 10 * MIN), fullAt: null, pace: { endPct: 71 } },
      { id: 'seven_day', pct: 64, resetsAt: iso(now + 2 * D + 5 * H), fullAt: null, pace: { endPct: 88, perDay: 12 } },
    ],
    stats: { total: 18400000, projects: [{ name: 'Checkout redesign', tokens: 9100000 }, { name: 'API migration', tokens: 5200000 }, { name: 'Docs site', tokens: 4100000 }], models: [{ name: 'Opus', tokens: 14300000 }, { name: 'Sonnet', tokens: 4100000 }] },
    switches: [], fetchedAt: now, lastActivityAt: now - 3 * MIN,
  });
  if (b) Object.assign(b, {
    label: 'Work', orgName: 'Team plan', status: 'ok', error: null, extra: null, spark: [], sessionCount: 0,
    metrics: [
      { id: 'five_hour', pct: 12, resetsAt: iso(now + 4 * H + 20 * MIN), fullAt: null, pace: null },
      { id: 'seven_day', pct: 81, resetsAt: iso(now + 3 * D + 2 * H), fullAt: null, pace: null },
    ],
    stats: { total: 6200000, projects: [], models: [] }, switches: [], fetchedAt: now, lastActivityAt: now - 5 * H,
  });
  const chat = (n, name, project, o) => ({
    id: 'demo/' + n + '.jsonl', usedAt: now - o.used * MIN, project, root: 'C:\\\\code\\\\' + project, title: name, titled: true, name, about: null,
    context: o.context, perMessage: { tokens: Math.round(o.context * 1.2), steps: 6, count: 5 }, cacheUntil: now + o.cache * MIN, cacheMinutes: 60,
    startContext: 38000, model: 'claude-opus', images: { count: o.images, bytes: o.images * 200000 }, size: 4000000,
    setup: { model: 'Opus', effort: 'high', ultracode: false, tools: 46, connectors: 4, biggest: [] },
    recent: true, owners: [a.key], createdAt: o.prompt ? now - o.prompt * MIN : 0, graphify: { enabled: o.graph, graph: o.graph, full: false, busy: false },
  });
  sessions = [
    chat(1, 'Checkout redesign', 'shop-web', { used: 3, context: 182000, cache: 52, images: 6, prompt: 2, graph: true }),
    chat(2, 'Fix the login bug', 'my-app', { used: 25, context: 540000, cache: 31, images: 2, prompt: 0, graph: true }),
    chat(3, 'API migration', 'billing-api', { used: 70, context: 128000, cache: -8, images: 0, prompt: 0, graph: false }),
  ];
  s.stats = { byAccount: { [a.key]: a.stats, ...(b ? { [b.key]: b.stats } : {}) }, contexts: sessions.map((c) => ({ id: c.id, usedAt: c.usedAt, name: c.name, context: c.context, owners: c.owners })) };
  state = s;
  tipsAt = now; // keeps the app from reading the real chats again for a while
  openSessions.clear();
  openDetails.clear();
  statsFor = null;
  sessionsFor = null;
  view = 'usage';
  if (what === 'sessions') { sessionsFor = a.key; openSessions.add(sessions[0].id); openDetails.add(sessions[0].id); }
  if (what === 'tips') view = 'tips';
  if (what === 'tray') { view = 'guide'; demo = { ...DEMO }; guideStep = 2; guideSpot = 0; }
  render();
  // The picture of the tray is of the icons alone, without the tour's ring and arrow.
  if (what === 'tray') light(null);
  return document.documentElement.lang;
};`);

async function shot(what, file, selector = '#app') {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await run(`__demo(${JSON.stringify(what)})`);
    await wait(1700);
    const before = await run('__leaks()');
    const box = JSON.parse(await run(`JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`));
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const s = await send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 } });
    const after = await run('__leaks()');
    const text = await run(`document.querySelector(${JSON.stringify(selector)}).innerText`);
    // The app may have put the real data back while the picture was being taken.
    if (before === 0 && after === 0) {
      fs.writeFileSync(path.join(outDir, file), Buffer.from(s.result.data, 'base64'));
      console.log(`\n== ${file} (${Math.round(box.width)}x${Math.round(box.height)}, attempt ${attempt}) — nothing real on screen\n${text.replace(/\n+/g, ' | ')}`);
      return;
    }
  }
  console.log(`\n== ${file}: NOT SAVED, real data kept showing`);
}

await shot('usage', 'accounts.png');
await shot('sessions', 'sessions.png');
await shot('tips', 'tips.png');
await shot('tray', 'tray.png', '.g-desktop');
// Back to the real data: the next state from the app replaces the made-up one.
await run(`closeGuide(); tipsAt = 0; api.refresh(); 'restored'`);
ws.close();
