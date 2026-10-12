// Tandem's own alert: one message at a time, in a small window the app puts right above
// its icons in the taskbar. The app sends the message; the page says how tall it came out,
// is told where it stands, shows it for a while and says when it is gone.
const box = document.getElementById('alert');
const tail = document.getElementById('alert-tail');
const calm = matchMedia('(prefers-reduced-motion: reduce)');

// It comes in the way the panel does: up a little as it appears, settling slowly.
const ENTER = { duration: 520, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'both' };
const LEAVE = { duration: 200, easing: 'ease-in', fill: 'both' };

const TAIL = 10; // how far the pointer reaches below the box

let timer = null;
let left = 0; // how long the message still has, in ms
let since = 0; // when its time last started running
let gone = true; // nothing on screen: between messages the box is empty and unseen

function leave(clicked) {
  if (gone) return;
  gone = true;
  clearTimeout(timer);
  const done = () => alertApi.done(clicked);
  if (calm.matches) {
    box.style.opacity = '0';
    return requestAnimationFrame(() => requestAnimationFrame(done));
  }
  // Told once the box has faded out, so the window hides showing nothing.
  box.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(8px)' }], LEAVE).onfinish = () => {
    box.style.opacity = '0';
    requestAnimationFrame(done);
  };
}

function run() {
  since = performance.now();
  timer = setTimeout(() => leave(false), left);
}

// The drawing of what the alert is about, in the color of how pressing it is.
function draw(kind, level) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[kind] || ICONS.bell);
  svg.append(path);
  const icon = document.getElementById('alert-icon');
  icon.className = `alert-icon ${['low', 'warn', 'crit'].includes(level) ? level : ''}`;
  icon.replaceChildren(svg);
}

// The limits or the chat the alert is about, as bars like the app's own: a short name,
// the bar and its figure. A bar is colored by how full it is unless it says otherwise,
// and may carry a tick (`mark`, a percentage of its length) where a threshold falls.
function measure(meters) {
  const named = meters.some((meter) => meter.tag);
  const rows = meters.map((meter) => {
    const pct = Math.max(0, Math.min(100, Number(meter.pct) || 0));
    const color = typeof meter.level === 'string' ? meter.level : level(pct);
    const cell = (tag, cls, text) => {
      const el = document.createElement(tag);
      el.className = cls;
      if (text != null) el.textContent = text;
      return el;
    };
    const bar = cell('div', `bar ${color}`);
    const fill = cell('div', '');
    fill.style.width = `${pct}%`;
    bar.append(fill);
    if (Number.isFinite(meter.mark)) {
      const tick = cell('i', '');
      tick.style.left = `${meter.mark}%`;
      bar.append(tick);
    }
    return [named && cell('small', '', meter.tag || ''), bar, cell('b', color, meter.text || `${pct}%`)].filter(Boolean);
  });
  const grid = document.getElementById('alert-meters');
  grid.className = `alert-meters ${named ? '' : 'plain'}`;
  grid.replaceChildren(...rows.flat());
}

alertApi.onSay(({ title, body, kind, level, meters, theme, language, ms }) => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.lang = language;
  document.getElementById('alert-title').textContent = title;
  document.getElementById('alert-body').textContent = body;
  draw(kind, level);
  measure(Array.isArray(meters) ? meters : []);
  for (const animation of box.getAnimations()) animation.cancel();
  box.style.opacity = '0';
  left = ms;
  // Laid out, though not seen yet: the app needs its height to place the window.
  // The window is as tall as the box plus the pointer that hangs under it.
  requestAnimationFrame(() => alertApi.size(Math.ceil(box.getBoundingClientRect().height) + TAIL));
});

// `tail` is how far from the left edge the icons are, when the alert stands right above
// them; without it there is no pointer.
alertApi.onPlace((where) => {
  tail.hidden = where.tail == null;
  if (where.tail != null) tail.style.left = `${where.tail}px`;
  gone = false;
  box.style.opacity = '';
  if (!calm.matches) box.animate([{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'translateY(0)' }], ENTER);
  run();
});

// Its time stops while the mouse is on it.
box.addEventListener('mouseenter', () => {
  if (gone) return;
  clearTimeout(timer);
  left = Math.max(1500, left - (performance.now() - since));
});
box.addEventListener('mouseleave', () => { if (!gone) run(); });
box.addEventListener('click', () => leave(true));
document.getElementById('alert-close').addEventListener('click', (e) => {
  e.stopPropagation();
  leave(false);
});
