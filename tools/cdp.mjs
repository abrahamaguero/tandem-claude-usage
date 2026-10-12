// Usage: node cdp.mjs <port> <out.png> [js expression to evaluate first]
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
  await new Promise((r) => setTimeout(r, 500));
}
const text = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
console.log('text:', text.result.result.value);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
ws.close();
