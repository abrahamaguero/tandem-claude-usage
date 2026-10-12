// Takes a picture of the panel alone, with what is around it see-through, for the README.
// Usage: node shot.mjs <port> <out.png> [js expression to evaluate first]
// The app has to be running with --remote-debugging-port=<port>.
import fs from 'node:fs';

const [port, out, expr] = process.argv.slice(2);
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
if (expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log('eval:', JSON.stringify(r.result.result?.value ?? r.result.exceptionDetails ?? null));
}
// Long enough for the panel to finish sliding and the tiles to finish coming in.
await new Promise((r) => setTimeout(r, 1800));
const box = await send('Runtime.evaluate', { expression: 'JSON.stringify(document.getElementById("app").getBoundingClientRect())', returnByValue: true });
const { x, y, width, height } = JSON.parse(box.result.result.value);
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale: 1 } });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log('saved', out, `${Math.round(width)}x${Math.round(height)}`);
ws.close();
