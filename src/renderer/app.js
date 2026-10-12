const $ = (id) => document.getElementById(id);
const viewUsage = $('view-usage');
const viewSettings = $('view-settings');
const viewGuide = $('view-guide');
const viewTips = $('view-tips');

let state = null;

const SWATCHES = ['#e91e8c', '#f72f57', '#00a0b0', '#d4ff00', '#ffffff', '#ff8a3d', '#a78bfa', '#38bdf8', '#34d399'];
const THEMES = [['obsidian', 'Obsidian'], ['aurora', 'Midnight Aurora'], ['velvet', 'Ultraviolet'], ['ember', 'Graphite Ember'], ['porcelain', 'Porcelain']];
let view = 'usage'; // 'usage' | 'settings' | 'guide' | 'tips'
let guideStep = 0; // page of the guide on show
let statsFor = null; // key of the card whose activity panel is open
let editingKey = null; // key of the card whose name is being edited
let paletteFor = null; // key of the organization whose color swatches are open in settings
let sessionsFor = null; // key of the card whose sessions panel is open
let sessions = [];
let sessionNote = '';
let sessionNoteError = false;
let sessionHelp = false;
const settingUp = new Set(); // project folders graphify is being set up in
let copiedFor = null; // id of the chat whose graphify command was just copied
const openDetails = new Set(); // ids of the chats whose secondary lines are unfolded
const openSessions = new Set(); // ids of the chats unfolded in the list; the rest show one line

const t = (key, vars) => translate(state.settings.language, key, vars);

// replaceChildren() would print nested arrays and skipped (false/null) items as text.
function setChildren(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((child) => child != null && child !== false));
}

// What has just appeared comes in animated. Everything is drawn again all the time, so an
// element is told how long ago it arrived (--elapsed, which the styles subtract from the
// animation's delay): drawn again on its way in, it carries on from there instead of
// starting over, and once it is in it is left alone.
const ARRIVE_MS = 1300; // the longest an entrance takes, with its stagger
const arrivals = new Map(); // key → when it first appeared
let arrived = new Set(); // the keys drawn in the render under way

function arriving(key, el) {
  arrived.add(key);
  const now = performance.now();
  if (!arrivals.has(key)) arrivals.set(key, now);
  const elapsed = now - arrivals.get(key);
  el.classList.toggle('arrive', elapsed < ARRIVE_MS);
  el.style.setProperty('--elapsed', `${Math.round(elapsed)}ms`);
  return el;
}

// Whatever was not drawn this time is gone, and will arrive again if it comes back.
function settleArrivals() {
  for (const key of arrivals.keys()) if (!arrived.has(key)) arrivals.delete(key);
  arrived = new Set();
}

// When something opens or folds, what is around it glides to its new place instead of
// jumping there. A view is drawn anew each time, so the pieces that may move carry a key:
// where each one was is noted before drawing, and afterwards it slides in from there.
const GLIDE = { duration: 520, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };

function keyed(key, el) {
  el.dataset.key = key;
  return el;
}

// Where a piece is, counted from the view's own corner: the panel sliding as a whole
// does not count as the piece moving.
function placeOf(root, el) {
  const origin = root.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  return [box.left - origin.left, box.top - origin.top + root.scrollTop];
}

function places(root) {
  const at = new Map();
  for (const el of root.querySelectorAll('[data-key]')) at.set(el.dataset.key, placeOf(root, el));
  return at;
}

function glide(root, before) {
  if (calm.matches) return;
  const moved = new Map();
  for (const el of root.querySelectorAll('[data-key]')) {
    const was = before.get(el.dataset.key);
    if (!was) continue;
    const now = placeOf(root, el);
    moved.set(el, [was[0] - now[0], was[1] - now[1]]);
  }
  for (const [el, [x, y]] of moved) {
    // What has just arrived has its own entrance. A piece inside another that moves is
    // carried along by it, so only its own share of the way is left to glide.
    if (el.closest('.arrive')) continue;
    const outer = moved.get(el.parentElement.closest('[data-key]')) || [0, 0];
    const dx = x - outer[0];
    const dy = y - outer[1];
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], GLIDE);
  }
}

// An account that changes form, from a block of tiles to a single one or back, does not
// just vanish: its old self stays a moment over the new one and fades away, so one turns
// into the other. The old elements themselves are kept for that, in a layer of their own
// that survives the redraws that come while they fade.
const ghostLayer = h('div', { class: 'ghosts' });

function accountsIn(root) {
  return [...root.querySelectorAll(':scope > .account')].map((el) => ({
    el, key: el.dataset.key, closed: el.classList.contains('closed'), left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth,
  }));
}

function fadeOut(root, were) {
  const now = new Map([...root.querySelectorAll(':scope > .account')].map((el) => [el.dataset.key, el.classList.contains('closed')]));
  for (const was of were) {
    if (now.get(was.key) === was.closed) continue;
    const ghost = was.el;
    ghost.classList.remove('arrive');
    // A ghost is no longer the account: nothing should take it for one, or slide it about.
    for (const el of [ghost, ...ghost.querySelectorAll('[data-key]')]) delete el.dataset.key;
    Object.assign(ghost.style, { left: `${was.left}px`, top: `${was.top}px`, width: `${was.width}px` });
    if (calm.matches) continue;
    ghostLayer.append(ghost);
    ghost.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.97)' }], { duration: 420, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }).onfinish = () => {
      ghost.remove();
      if (!ghostLayer.childElementCount) ghostLayer.remove();
    };
  }
  if (ghostLayer.childElementCount) root.append(ghostLayer);
}

const SOUNDS = [['note', 'Note'], ['tritone', 'Tri-tone'], ['glass', 'Glass'], ['pop', 'Pop'], ['chord', 'Chord']];
const chime = new Audio();

// The tallest a view may get before it scrolls: the screen, minus the header and a margin.
// Worked out again when the window changes, which it does on moving to another screen.
const setMaxHeight = () => document.documentElement.style.setProperty('--max-h', `${screen.availHeight - 80}px`);
setMaxHeight();
window.addEventListener('resize', setMaxHeight);
// Something dropped on the window is not for it: without this the page would try to open it.
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());

// People who ask Windows for less motion get the changes without the animations.
const calm = matchMedia('(prefers-reduced-motion: reduce)');

function playChime(id) {
  if (!state) return;
  if (!id) id = state.settings.soundId;
  const name = SOUNDS.some(([v]) => v === id) ? id : SOUNDS[0][0];
  chime.src = `sounds/${name}.wav`;
  chime.volume = Math.min(1, Math.max(0, (state.settings.volume ?? 60) / 100));
  chime.play().catch(() => {});
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    // A property left without a value is left alone: set, it would read "undefined".
    if (v == null) continue;
    if (k === 'color') el.style.setProperty('--c', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el[k] = v;
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) el.append(child);
  }
  return el;
}

// How long until a moment, in the words of one of two families of texts: "resets in 2 h"
// for a limit (resets…) and plain "in 2 h" for anything else (in…).
function until(iso, family) {
  if (!iso) return '';
  const mins = Math.round((new Date(iso) - Date.now()) / 60000);
  if (mins <= 0) return t(`${family}Now`);
  const d = Math.floor(mins / 1440);
  const hrs = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) return t(`${family}Days`, { d, h: hrs });
  if (hrs) return t(`${family}Hours`, { h: hrs, m });
  return t(`${family}Mins`, { m });
}

const untilReset = (iso) => until(iso, 'resets');
const fromNow = (iso) => until(iso, 'in');

// How far along a limit is, as the color it is shown in: 'low' (green) while most of it is
// left, '' (the theme's blue) from there up to the warning, then 'warn' and 'crit', which
// are the two thresholds the notifications use. The first step is two thirds of the way
// to the warning: 50% when the warning is at 75%.
function level(pct) {
  const { warnAt, critAt } = state.settings;
  if (pct >= critAt) return 'crit';
  if (pct >= warnAt) return 'warn';
  return pct >= Math.round(warnAt * 2 / 3) ? '' : 'low';
}

// ---------- usage view ----------

// Clock time of a moment; includes the weekday when it is not today.
function clock(ms) {
  const date = new Date(ms);
  const today = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(state.settings.language, today
    ? { hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// Extra-usage amounts arrive in minor units (cents for USD). A currency the system does
// not know is shown as its code after the number instead of breaking the view.
function money(amount, extra) {
  const value = amount / 10 ** (extra.decimal_places ?? 2);
  const currency = extra.currency || 'USD';
  try {
    return value.toLocaleString(state.settings.language, { style: 'currency', currency });
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

// One limit as a tile: its name, how much is used in big, the bar, and when it resets.
// `wide` makes it span the row, for the one left over when the limits are an odd number.
function metricEl(m, a, wide) {
  const fill = h('div');
  fill.style.width = `${Math.min(m.pct, 100)}%`;
  const extra = m.id === 'extra_usage' && a.extra && typeof a.extra.used_credits === 'number' && a.extra.monthly_limit;
  const lvl = level(m.pct);
  return h('div', { class: `tile metric ${lvl} ${wide ? 'wide' : ''}` },
    h('div', { class: 'metric-label' }, t(`metric.${m.id}`)),
    extra
      ? h('div', { class: 'metric-value long' }, `${money(a.extra.used_credits, a.extra)} / ${money(a.extra.monthly_limit, a.extra)}`)
      : h('div', { class: 'metric-value' }, String(m.pct), h('small', {}, '%')),
    h('div', { class: `bar ${lvl}` }, fill),
    m.resetsAt && h('div', { class: 'metric-reset' }, `${untilReset(m.resetsAt)} · ${clock(m.resetsAt)}`),
    paceEl(m));
}

// Where the limit is heading. In orange when it would run out before it resets; otherwise
// a quiet line with where it would end, and what that leaves.
function paceEl(m) {
  if (m.fullAt) return h('div', { class: 'pace' }, t('paceFull', { when: fromNow(m.fullAt), at: clock(m.fullAt) }));
  const p = m.pace;
  if (!p) return null;
  if (m.id === 'five_hour') return h('div', { class: 'pace calm', title: t('paceSessionTip') }, t('paceSession', { pct: p.endPct, unused: 100 - p.endPct }));
  if (p.fullAt) return h('div', { class: 'pace', title: t('paceWeekTip') }, t('paceWeekFull', { at: clock(p.fullAt) }));
  return h('div', { class: 'pace calm', title: t('paceWeekTip') }, t('paceWeek', { pct: p.endPct, day: p.perDay }));
}

const SVG = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children.filter(Boolean));
  return el;
}

// The shape that decorates the big tiles: eight rounded petals. It sits in its own box,
// which is what cuts it off at the tile's edge.
function burstEl() {
  return h('span', { class: 'deco' }, svgEl('svg', { viewBox: '0 0 100 100', class: 'burst' },
    ...[0, 45, 90, 135].map((turn) => svgEl('rect', { x: 38, y: 2, width: 24, height: 96, rx: 12, transform: `rotate(${turn} 50 50)` }))));
}

// Small area chart of the account's main limit over the last hours. The vertical scale
// adapts to the peak, so low usage is still readable; the scale's top is labelled.
function sparkEl(a) {
  if (!a.spark || a.spark.length < 3) return null;
  const values = a.spark.map((point) => point[1]);
  const peak = Math.max(...values);
  // A flat line says nothing, so wait until the usage has actually moved.
  if (peak === Math.min(...values)) return null;
  const top = [5, 10, 25, 50, 100].find((v) => v >= peak) || 100;
  const t0 = a.spark[0][0];
  const span = Math.max(a.spark[a.spark.length - 1][0] - t0, 1);
  const x = (time) => ((time - t0) / span) * 100;
  const y = (pct) => 40 - (Math.min(pct, top) / top) * 36;
  const line = a.spark.map(([time, pct]) => `${x(time).toFixed(2)},${y(pct).toFixed(2)}`).join(' ');

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 100 40');
  svg.setAttribute('preserveAspectRatio', 'none');
  const area = document.createElementNS(SVG, 'polygon');
  area.setAttribute('points', `0,40 ${line} 100,40`);
  const stroke = document.createElementNS(SVG, 'polyline');
  stroke.setAttribute('points', line);
  svg.append(area, stroke);

  const last = values[values.length - 1];
  const dot = h('i', { class: 'chart-dot' });
  dot.style.top = `${(y(last) / 40) * 100}%`;
  const mins = Math.round(span / 60000);
  return h('div', { class: 'tile chart', title: t('sparkTip') },
    h('div', { class: 'chart-row' },
      h('span', {}, t('sparkCaption', { metric: t(`metric.${a.metrics[0].id}`), span: mins < 90 ? `${mins} min` : `${Math.round(mins / 60)} h` })),
      h('span', {}, `${top}%`)),
    h('div', { class: 'chart-plot' }, svg, dot),
    h('div', { class: 'chart-row' }, h('span', {}, clock(t0)), h('span', {}, t('now', { pct: last }))));
}

function nameInput(a) {
  let done = false;
  const finish = (save, value) => {
    if (done) return;
    done = true;
    editingKey = null;
    document.querySelector('.name-edit').blur();
    const [profileId, uuid] = a.key.split(':');
    if (save) api.renameOrg(profileId, uuid, value);
    else render();
  };
  return h('input', {
    type: 'text', class: 'name-edit', value: a.label, maxLength: 30,
    onclick: (e) => e.stopPropagation(),
    onkeydown: (e) => {
      if (e.key === 'Enter') finish(true, e.target.value);
      if (e.key === 'Escape') finish(false);
    },
    onblur: (e) => finish(true, e.target.value),
  });
}

// Shown while a card's name is being edited. Uses mousedown so the name field keeps focus.
function swatchesEl(a) {
  const [profileId, uuid] = a.key.split(':');
  return h('div', { class: 'swatches', onclick: (e) => e.stopPropagation() },
    SWATCHES.map((c) => h('button', {
      class: `swatch ${c === a.color ? 'current' : ''}`, color: c, title: c,
      onmousedown: (e) => {
        e.preventDefault();
        e.target.closest('.account').style.setProperty('--c', c);
        api.setOrgColor(profileId, uuid, c);
      },
    })));
}

function startRename(key) {
  editingKey = key;
  render();
  const input = document.querySelector('.name-edit');
  if (input) {
    input.focus();
    input.select();
  }
}

// The account's two main limits as rings: the outer one for the session, the inner one for
// the week, each filled by how much is used. They are drawn in one ink, to sit on the
// account's color; the color of the level is on the tile of each limit.
function ringsEl(a) {
  const session = a.metrics.find((m) => m.id === 'five_hour') || a.metrics[0];
  const weekly = a.metrics.find((m) => m.id === 'seven_day') || a.metrics[1];
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 44 44');
  svg.setAttribute('class', 'rings');
  const circle = (r, cls) => {
    const el = document.createElementNS(SVG, 'circle');
    el.setAttribute('cx', 22);
    el.setAttribute('cy', 22);
    el.setAttribute('r', r);
    el.setAttribute('class', cls);
    svg.append(el);
    return el;
  };
  const ring = (metric, r) => {
    circle(r, 'ring-track');
    if (!metric || metric.pct <= 0) return;
    const length = 2 * Math.PI * r;
    const arc = circle(r, 'ring-arc');
    arc.setAttribute('stroke-dasharray', `${(Math.min(metric.pct, 100) / 100) * length} ${length}`);
    arc.setAttribute('transform', 'rotate(-90 22 22)');
  };
  ring(session, 18.5);
  ring(weekly, 11);
  circle(3.5, 'ring-dot');
  const title = document.createElementNS(SVG, 'title');
  title.textContent = [session, weekly].filter(Boolean).map((m) => `${t(`metric.${m.id}`)}: ${m.pct}%`).join(' · ');
  svg.append(title);
  return svg;
}

// Session and weekly use as two small boxes, matching the tray icons:
// outlined for the session, solid for the week, colored by how much is used.
function chipsEl(a) {
  const session = a.metrics.find((m) => m.id === 'five_hour') || a.metrics[0];
  const weekly = a.metrics.find((m) => m.id === 'seven_day') || a.metrics[1];
  // "5h" and "7d" read the same in every language ("S" would be both Sesión and Semanal).
  const chip = (m, solid, tag) => m && h('span', {
    class: `chip ${solid ? 'solid' : ''} ${level(m.pct)}`,
    title: `${t(`metric.${m.id}`)}: ${m.pct}%`,
  }, h('small', {}, tag), String(m.pct));
  return h('span', { class: 'chips' }, chip(session, false, '5h'), chip(weekly, true, '7d'));
}

// Who the account is: its rings, its name and organization, and whether Claude is on it
// right now. The same pieces head an open account and make up a closed one.
function identityEl(a, active) {
  return [
    a.status === 'ok' && a.metrics.length > 0 && h('span', { class: 'rings-box' }, ringsEl(a)),
    h('div', { class: 'identity' },
      h('div', { class: 'identity-line' },
        editingKey === a.key ? nameInput(a) : h('span', { class: 'name' }, a.label),
        a.key.includes(':') && editingKey !== a.key && h('button', {
          class: 'rename', title: t('rename'),
          onclick: (e) => { e.stopPropagation(); startRename(a.key); },
        }, '✎')),
      a.orgName && h('span', { class: 'org' }, a.orgName)),
    active && h('span', { class: 'now' }, t('active')),
  ];
}

// A tile that opens something below it: what it is, one number about it, and an arrow.
function actionEl(cls, label, value, open, onclick) {
  return h('button', { class: `tile action ${cls} ${open ? 'open' : ''}`, onclick },
    h('span', {}, h('small', {}, label), h('strong', {}, value)),
    h('i', { class: 'go' }, open ? '↑' : '↗'));
}

// An account as a block of tiles: its own on top, in its color; then one per limit, the
// trend, and the two that open its chats and its activity. In compact mode, the accounts
// not on show are a single tile each, with just their two numbers.
function cardEl(a) {
  const active = a.key === state.activeKey;
  const ok = a.status === 'ok';
  // An organization being tracked, with its figures. A sign-in with none turned on, or
  // one that is signed out or still loading, is only its name and what to do about it.
  const tracked = ok && Boolean(a.stats);
  const pick = () => ok && api.setActive(a.key);
  // Only an account with something to show folds away: one that needs signing in, or
  // that failed, stays open so that what it needs is in sight.
  if (state.settings.compact && tracked && a.key !== state.viewKey) {
    return keyed(`acct:${a.key}`, h('div', { class: 'account closed', color: a.color, title: t('cardTip'), onclick: pick },
      identityEl(a, active),
      a.metrics.length > 0 && chipsEl(a),
      editingKey === a.key && swatchesEl(a)));
  }

  let body;
  if (a.status === 'login') {
    body = h('div', { class: 'tile wide status' },
      h('span', { class: 'note' }, t('signedOut')),
      h('button', { class: 'primary', onclick: () => api.login(a.profileId) }, t('signIn')));
  } else if (a.status === 'loading') {
    body = h('div', { class: 'tile wide note' }, t('loading'));
  } else if (a.status === 'error') {
    body = h('div', { class: 'tile wide note error' }, a.error || t('errFetch'));
  } else if (!tracked) {
    body = h('div', { class: 'tile wide note' }, t('noOrgs'));
  } else if (!a.metrics.length) {
    body = h('div', { class: 'tile wide note' }, t('noLimits'));
  } else {
    const odd = a.metrics.length % 2 === 1;
    body = [
      // The last figures stay on show when a refresh fails, and say that they are old.
      a.error && h('div', { class: 'tile wide note error' }, t('stale', { at: a.fetchedAt ? clock(a.fetchedAt) : '–' })),
      a.metrics.map((m, i) => metricEl(m, a, odd && i === a.metrics.length - 1)),
      sparkEl(a),
    ];
  }
  const chats = sessionsFor === a.key;
  const stats = statsFor === a.key;
  // With the account in use being detected, clicking an open account changes nothing.
  const choosing = ok && !state.settings.autoSwitch;
  return arriving(`open:${a.key}`, keyed(`acct:${a.key}`, h('section', { class: 'account', color: a.color },
    h('div', { class: `tile hero ${choosing ? '' : 'still'}`, title: choosing ? t('heroTip') : '', onclick: pick }, burstEl(), identityEl(a, active)),
    editingKey === a.key && swatchesEl(a),
    body,
    tracked && actionEl('chats', t('sessions'), String(a.sessionCount), chats, () => toggleSessions(a.key)),
    tracked && actionEl('', t('insights'), tokens(a.stats.total), stats, () => { statsFor = stats ? null : a.key; sessionsFor = null; render(); }),
    tracked && stats && arriving(`stats:${a.key}`, keyed(`stats:${a.key}`, statsEl(a))),
    tracked && chats && arriving(`chats:${a.key}`, keyed(`chats:${a.key}`, sessionsEl(a))))));
}

async function toggleSessions(key) {
  if (sessionsFor === key) {
    sessionsFor = null;
    return render();
  }
  // The list is read before the panel is opened, so that it never opens on an older one.
  sessions = await api.listSessions();
  view = 'usage';
  sessionsFor = key;
  // One panel at a time: the chats take the place of the activity.
  statsFor = null;
  note('');
  // The list opens with only the chat used last unfolded; the rest are one line each.
  openSessions.clear();
  const latest = sessions.find((s) => !s.owners || s.owners.includes(key));
  if (latest) openSessions.add(latest.id);
  render();
}

// The line under the list of chats: what the last action did, or why it failed.
function note(text, error = false) {
  sessionNote = text;
  sessionNoteError = error;
}

async function generate(ids) {
  sessions = await api.generatePrompts(ids);
  // What was made, which may be fewer than what was asked for.
  note(t('promptsGenerated', { n: sessions.filter((s) => ids.includes(s.id) && s.createdAt).length }));
  render();
}

async function copy(ids) {
  const n = await api.copyPrompts(ids);
  note(t('promptsCopied', { n }));
  render();
}

// Runs one of the two graphify actions on a chat's project. Whatever happens, the line
// stops saying it is working.
async function graphifyRun(s, action, report) {
  settingUp.add(s.root);
  note('');
  render();
  try {
    const result = await action(s.id);
    sessions = result.sessions;
    if (result.ok) report(result);
    else note(t(`graphifyErr.${result.error}`, { detail: result.detail || '' }), true);
  } catch (err) {
    note(t('graphifyErr.failed', { detail: String(err.message || err) }), true);
  } finally {
    settingUp.delete(s.root);
    render();
  }
}

const setupGraphify = (s) => graphifyRun(s, api.setupGraphify, (result) => {
  if (result.graph) note(t('graphifyDone', { project: s.project }));
  else if (result.reason === 'nocode') note(t('graphifyNoCode', { project: s.project }));
  else note(t('graphifyNoGraph', { project: s.project, detail: result.detail || '' }), true);
});

const turnOffGraphify = (s) => graphifyRun(s, api.turnOffGraphify, () => note(t('graphifyOffDone', { project: s.project })));

async function copyGraphify(s) {
  await api.copyGraphify();
  note(t('graphifyCopied'));
  // The button itself says it worked, since the note may be out of sight below a long list.
  copiedFor = s.id;
  render();
  setTimeout(() => {
    if (copiedFor !== s.id) return;
    copiedFor = null;
    render();
  }, 2500);
}

function ago(ms) {
  const mins = Math.max(1, Math.round((Date.now() - ms) / 60000));
  return mins < 60 ? t('agoMins', { n: mins }) : t('agoHours', { n: Math.round(mins / 60) });
}

function stamp(ms) {
  return new Date(ms).toLocaleString(state.settings.language, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Chat size as a bar. With a warning threshold set, the bar spans twice the threshold
// and a tick marks it, so "how close am I" reads at a glance.
function contextBar(s) {
  const limit = state.settings.contextWarn;
  const scale = limit ? limit * 2 : 600000;
  const fill = h('div');
  fill.style.width = `${Math.min(100, (s.context / scale) * 100)}%`;
  return h('div', { class: `bar ${contextLevel(s)}` }, fill, limit > 0 && h('i'));
}

function contextEl(s) {
  const limit = state.settings.contextWarn;
  return h('div', { class: 'ctx-line', title: t('ctxTip') },
    h('span', { class: 'ctx-label' }, t('ctxWord')),
    contextBar(s),
    h('span', { class: `ctx-value ${contextLevel(s)}` }, limit ? `${tokens(s.context)} / ${limit / 1000}K` : tokens(s.context)));
}

// How far past the warning threshold a chat is: '', 'warn' or 'crit'.
function contextLevel(s) {
  const limit = state.settings.contextWarn;
  return !limit ? '' : s.context >= limit ? 'crit' : s.context >= limit * 0.75 ? 'warn' : '';
}

const infoLine = (label, cls, text, tip) => h('div', { class: 'ctx-line', title: tip || '' },
  h('span', { class: 'ctx-label' }, label),
  h('span', { class: `ctx-state ${cls}` }, text));

// What one message costs in this chat, measured from the user's latest ones. It follows
// the size of the chat, so it is colored like the bar above it.
function costEl(s) {
  const cost = s.perMessage;
  if (!cost) return null;
  return infoLine(t('costWord'), contextLevel(s), t('costPerMessage', { tokens: tokens(cost.tokens) }),
    t('costTip', { n: cost.count, steps: cost.steps, context: tokens(s.context) }));
}

// Whether sending the chat again is still cheap. Once the cache is gone, the next message
// pays for the whole chat, which for a big one is the moment to continue in a new chat.
function cacheEl(s) {
  if (!s.cacheUntil) return null;
  const mins = Math.ceil((s.cacheUntil - Date.now()) / 60000);
  const tip = t('cacheTip', { ttl: s.cacheMinutes });
  if (mins <= 0) return infoLine(t('cacheWord'), s.context >= 100000 ? 'warn' : '', t('cacheExpired', { context: tokens(s.context) }), tip);
  return infoLine(t('cacheWord'), mins <= 10 ? 'warn' : '', t('cacheWarm', { m: mins }), tip);
}

// The model and thinking effort the chat is set to. Marked at the highest efforts, where
// every step costs more.
function modelEl(s) {
  const setup = s.setup;
  if (!setup || !setup.model) return null;
  const heavy = ['xhigh', 'max'].includes(setup.effort) || setup.ultracode;
  const text = [setup.model, setup.effort && t('effortOf', { effort: setup.effort }), setup.ultracode && 'ultracode'].filter(Boolean).join(' · ');
  return infoLine(t('modelWord'), heavy ? 'warn' : '', text, t(heavy ? 'modelHeavyTip' : 'modelTip'));
}

// What the chat already carried at its first reply, and how many connectors it loads.
// The tooltip names the connectors that bring the most tools.
function startEl(s) {
  const setup = s.setup || {};
  const text = [
    s.startContext > 0 && t('startTokens', { tokens: tokens(s.startContext) }),
    setup.connectors > 0 && t('startConnectors', { n: setup.connectors }),
  ].filter(Boolean).join(' · ');
  if (!text) return null;
  const list = (setup.biggest || []).map((c) => `${c.name === 'local' ? t('localServers') : c.name} ${c.tools}`).join(' · ');
  return infoLine(t('startWord'), '', text, list ? `${t('startTip')}\n\n${t('startBiggest', { tools: setup.tools, list })}` : t('startTip'));
}

// How many images the chat holds and how much of its file they are. Marked when they are
// most of it: those are the chats that grow fastest.
function imagesEl(s) {
  const images = s.images;
  if (!images || !images.count) return null;
  const share = s.size ? Math.round((images.bytes / s.size) * 100) : 0;
  return infoLine(t('imagesWord'), share >= 50 && images.count >= 20 ? 'warn' : '', t('imagesText', { n: images.count, pct: share }), t('imagesTip'));
}

// graphify for the chat's project, as one line: whether it is on, and the one thing to do
// next. Off: turn it on. On: copy the command that builds the full graph inside a chat.
function graphifyEl(s) {
  const g = s.graphify;
  if (!g) return null;
  const line = (cls, text, tip, button) => h('div', { class: 'ctx-line' },
    h('span', { class: 'ctx-label' }, 'Graphify'),
    h('span', { class: `ctx-state ${cls}`, title: tip }, text),
    button);
  if (g.busy || settingUp.has(s.root)) return line('', t('graphifyBusy'), '');
  if (!g.enabled) {
    const tip = t('graphifyTip', { folder: s.root });
    return line('', t('graphifyOff'), tip,
      h('button', { class: 'ghost', title: tip, onclick: () => setupGraphify(s) }, t('graphifyTurnOn')));
  }
  // Whatever state it is on in, it can be turned off again.
  const off = h('button', { class: 'ghost', title: t('graphifyTurnOffTip', { folder: s.root }), onclick: () => turnOffGraphify(s) }, t('graphifyTurnOff'));
  // On but without a graph (the build was cut short, or failed): offer to build it.
  if (!g.graph) {
    return line('on', t('graphifyOnNoGraph'), t('graphifyNoGraphTip', { folder: s.root }),
      [h('button', { class: 'ghost', title: t('graphifyBuildTip', { folder: s.root }), onclick: () => setupGraphify(s) }, t('graphifyBuild')), off]);
  }
  // With the full graph already built there is no command left to copy.
  if (g.full) return line('on', t('graphifyOnFull'), t('graphifyOnFullTip', { folder: s.root }), off);
  return line('on', t('graphifyOn'), t('graphifyOnTip', { folder: s.root }),
    [h('button', { class: 'ghost', title: t('graphifyCopyTip'), onclick: () => copyGraphify(s) }, t(copiedFor === s.id ? 'graphifyCopiedShort' : 'graphifyCopy')), off]);
}

// One chat: its name and its handoff prompt on top; below, everything about its context,
// which is how big the chat is and graphify for its project.
function sessionRow(s) {
  const fold = () => {
    if (openSessions.has(s.id)) openSessions.delete(s.id);
    else openSessions.add(s.id);
    render();
  };
  // Folded, a chat is one line: its name and how big it is. Pressing it unfolds the rest.
  if (!openSessions.has(s.id)) {
    return keyed(`chat:${s.id}`, h('div', { class: 'session folded', title: t('sessionOpen'), onclick: fold },
      h('span', { class: 'session-name' }, s.name),
      s.context > 0 && contextBar(s),
      s.context > 0 && h('span', { class: `ctx-value ${contextLevel(s)}` }, tokens(s.context)),
      h('i', { class: 'fold' }, '▾')));
  }
  // The session kept going after its prompt was generated, so the prompt may be missing the latest work.
  const stale = s.createdAt && s.recent && s.usedAt > s.createdAt;
  const status = !s.createdAt ? t('lastUsed', { when: ago(s.usedAt) })
    : t(stale ? 'promptStale' : 'promptCreated', { when: stamp(s.createdAt) });
  // The size of the chat, its cache and graphify are always there: they are what to act
  // on. The rest explains the chat and stays folded until "More" is pressed.
  const extra = [costEl(s), modelEl(s), startEl(s), imagesEl(s)];
  const open = openDetails.has(s.id);
  const [cost, ...others] = open ? extra : [];
  const toggle = extra.some(Boolean) && h('button', {
    class: 'ghost more',
    onclick: () => {
      if (open) openDetails.delete(s.id);
      else openDetails.add(s.id);
      render();
    },
  }, open ? `${t('less')} ▴` : `${t('more')} ▾`);
  const context = [s.context > 0 && contextEl(s), cost, cacheEl(s), others, graphifyEl(s), toggle].flat().filter(Boolean);
  return arriving(`chat:${s.id}`, keyed(`chat:${s.id}`, h('div', { class: 'session' },
    h('div', { class: 'session-main' },
      h('div', { class: 'session-info', title: t('sessionClose'), onclick: fold },
        h('span', { class: 'session-name', title: s.root || '' }, s.name),
        s.about && h('span', { class: 'session-about' }, s.about),
        h('span', { class: `session-time ${stale ? 'stale' : ''}` }, status)),
      s.createdAt && h('button', { class: 'primary', onclick: () => copy([s.id]) }, t('copy')),
      s.recent && h('button', { class: 'ghost', title: t(s.createdAt ? 'regenerate' : 'generate'), onclick: () => generate([s.id]) },
        s.createdAt ? '↻' : t('generate')),
      h('i', { class: 'fold', title: t('sessionClose'), onclick: fold }, '▴')),
    context.length > 0 && h('div', { class: 'session-context' }, context))));
}

function sessionsEl(a) {
  // Chats used while this account was the one in use; unknown ones show everywhere.
  const mine = sessions.filter((s) => !s.owners || s.owners.includes(a.key));
  const recentIds = mine.filter((s) => s.recent).map((s) => s.id);
  return h('div', { class: 'tile sessions' },
    h('div', { class: 'handoff-actions' },
      h('button', { class: 'ghost', disabled: !recentIds.length, onclick: () => generate(recentIds) }, t('generateAll')),
      h('button', { class: `ghost help-toggle ${sessionHelp ? 'on' : ''}`, title: t('helpTip'), onclick: () => { sessionHelp = !sessionHelp; render(); } }, '?')),
    sessionHelp && h('div', { class: 'help' },
      h('strong', {}, t('helpTitle')),
      h('ol', {}, ['helpStep1', 'helpStep2', 'helpStep3', 'helpStep4'].map((key) => h('li', {}, t(key)))),
      h('div', {}, t('helpStale')),
      h('div', {}, t('helpContext')),
      h('div', {}, t('helpOwner')),
      h('div', {}, t('helpMore')),
      h('div', {}, t('helpCost')),
      h('div', {}, t('helpCache')),
      h('div', {}, t('helpModel')),
      h('div', {}, t('helpStart')),
      h('div', {}, t('helpImages')),
      h('div', {}, t('helpGraphify'))),
    !mine.length && h('div', { class: 'note' }, t('sessionsNone')),
    mine.map(sessionRow),
    sessionNote && h('div', { class: `note ${sessionNoteError ? 'error' : 'ok'}` }, sessionNote));
}

// The chats of the account in use, which a notification or the tray menu asks for. Its
// card may be folded, in compact mode, and a folded card has no list: it is opened first.
function openActiveSessions() {
  if (!state || !state.activeKey) return;
  if (state.viewKey !== state.activeKey) api.setActive(state.activeKey);
  if (sessionsFor !== state.activeKey) toggleSessions(state.activeKey);
}

function renderUsage() {
  if (!state.accounts.length) {
    // Left alone once drawn: drawn again, its bicycle would start pedalling from the top.
    const drawn = `empty ${state.settings.language}`;
    if (viewUsage.dataset.drawn === drawn) return;
    viewUsage.dataset.drawn = drawn;
    setChildren(viewUsage,
      h('div', { class: 'tile empty' },
        tandemEl('ride'),
        h('p', {}, t('empty')),
        h('button', { class: 'primary', onclick: () => setView('settings') }, t('addAccount'))));
    return;
  }
  viewUsage.dataset.drawn = '';
  const before = places(viewUsage);
  const were = accountsIn(viewUsage);
  // One account that cannot be drawn must not take the rest of the view with it.
  setChildren(viewUsage, state.accounts.map((a) => {
    try {
      return cardEl(a);
    } catch (err) {
      console.error('[account]', err);
      return h('div', { class: 'tile note error' }, `${a.label}: ${t('errFetch')}`);
    }
  }));
  fadeOut(viewUsage, were);
  glide(viewUsage, before);
}

// ---------- per-account activity ----------

// A count of tokens, short: 950 · 12K · 1.4M, with the decimal mark of the language.
function tokens(n) {
  if (n >= 999500) return `${(n / 1e6).toLocaleString(state.settings.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function shareRows(rows) {
  const max = Math.max(1, ...rows.map((r) => r.tokens));
  return rows.map((r) => {
    const fill = h('div');
    fill.style.width = `${(r.tokens / max) * 100}%`;
    return h('div', { class: 'share' },
      h('div', { class: 'metric-row' }, h('span', { class: 'share-name' }, r.name), h('span', { class: 'reset' }, tokens(r.tokens))),
      h('div', { class: 'bar' }, fill));
  });
}

// Claude Code activity while this account was the active one.
function statsEl(a) {
  const { stats, switches } = a;
  return h('div', { class: 'tile stats' },
    h('div', { class: 'insights-head' },
      h('strong', {}, t('insightsTitle')),
      h('span', { class: 'reset', title: t('tokensTip') }, t('tokensTotal', { n: tokens(stats.total) }))),
    !stats.total && h('div', { class: 'note' }, t('statsNone')),
    stats.projects.length > 0 && [h('h3', {}, t('byChat')), shareRows(stats.projects)],
    stats.models.length > 0 && [h('h3', {}, t('byModel')), shareRows(stats.models)],
    switches.length > 0 && [
      h('h3', {}, t('switchLog')),
      [...switches].reverse().map((s) => h('div', { class: 'switch-row' },
        h('span', { class: 'switch-name' }, clock(s.t)),
        h('span', { class: 'reset' }, t(s.auto ? 'switchAuto' : 'switchManual')))),
    ],
    h('div', { class: 'note small' }, t('insightsNote')));
}

// ---------- settings view ----------

// A select with its arrow drawn by the styles, in a small circle of its own.
const picker = (select) => h('span', { class: 'picker' }, select);

function toggleRow(name, label) {
  return h('div', { class: 'row' },
    h('label', {}, label),
    h('input', { type: 'checkbox', checked: !!state.settings[name], onchange: (e) => api.setSetting(name, e.target.checked) }));
}

// One of the two marks an alert goes off at. The first always stays below the second.
function numberInput(name) {
  const [low, high] = name === 'warnAt' ? [1, state.settings.critAt - 1] : [state.settings.warnAt + 1, 100];
  return h('input', {
    type: 'number', min: low, max: high, value: state.settings[name],
    onchange: (e) => {
      const v = Math.max(low, Math.min(high, Math.round(Number(e.target.value)) || low));
      e.target.blur();
      api.setSetting(name, v);
    },
  });
}

// "Remove" signs an account out for good, so it asks once more: the first press turns
// the button into the question, and only a second one, soon after, removes.
let removing = null; // what the question is about
function removeButton(what, tip, remove) {
  const asking = removing === what;
  return h('button', {
    class: 'danger', title: tip,
    onclick: (e) => {
      e.target.blur();
      if (asking) {
        removing = null;
        return remove();
      }
      removing = what;
      render();
      setTimeout(() => {
        if (removing !== what) return;
        removing = null;
        render();
      }, 4000);
    },
  }, t(asking ? 'removeSure' : 'remove'));
}

// Matches the color of the organization's card; hidden organizations have none.
function cardColor(p, o) {
  const card = state.accounts.find((a) => a.key === `${p.id}:${o.uuid}`);
  return card ? card.color : 'var(--line)';
}

function profileEl(p) {
  const ok = p.status === 'ok';
  return h('div', { class: 'profile' },
    h('div', { class: 'row' },
      h('span', { class: `dot ${ok ? 'ok' : ''}` }),
      h('span', { class: 'name' }, p.label),
      !ok && h('button', { class: 'ghost', onclick: (e) => { e.target.blur(); api.login(p.id); } }, t('signIn')),
      !p.orgs.length && removeButton(p.id, t('removeTip'), () => api.removeProfile(p.id))),
    p.orgs.map((o) => {
      const key = `${p.id}:${o.uuid}`;
      const color = cardColor(p, o);
      return [
        h('div', { class: 'org-row', color },
          h('input', { type: 'checkbox', checked: o.enabled, title: t('orgShowTip'), onchange: (e) => { e.target.blur(); api.toggleOrg(p.id, o.uuid, e.target.checked); } }),
          h('input', { type: 'text', value: o.alias || '', placeholder: p.label, maxLength: 30, title: t('orgNameTip'), onchange: (e) => api.renameOrg(p.id, o.uuid, e.target.value) }),
          // Opens the same swatches a card shows while its name is edited.
          h('button', {
            class: `swatch ${paletteFor === key ? 'current' : ''}`, color, title: t('colorTip'),
            onclick: (e) => { e.target.blur(); paletteFor = paletteFor === key ? null : key; render(); },
          }),
          h('span', { class: 'org-name', title: o.name }, o.name),
          removeButton(key, t('removeOrgTip'), () => api.removeOrg(p.id, o.uuid))),
        paletteFor === key && h('div', { class: 'swatches' },
          SWATCHES.map((c) => h('button', {
            class: `swatch ${c === color ? 'current' : ''}`, color: c, title: c,
            onclick: (e) => { e.target.blur(); paletteFor = null; api.setOrgColor(p.id, o.uuid, c); },
          }))),
      ];
    }));
}

function renderSettings() {
  const newName = h('input', { type: 'text', placeholder: t('namePlaceholder'), maxLength: 30 });
  // Blur first: the form is not rebuilt while it is being typed in, and the new account
  // has to show up in it.
  const add = () => {
    newName.blur();
    api.addProfile(newName.value);
    newName.value = '';
  };
  newName.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  const refresh = h('select', { onchange: (e) => { e.target.blur(); api.setSetting('refreshSec', Number(e.target.value)); } },
    [[30, '30 s'], [60, '1 min'], [120, '2 min'], [300, '5 min']].map(([v, label]) =>
      h('option', { value: v, selected: state.settings.refreshSec === v }, label)));

  // Blur first: the form is not rebuilt while one of its controls has focus.
  const language = h('select', { onchange: (e) => { e.target.blur(); api.setSetting('language', e.target.value); } },
    [['en', 'English'], ['es', 'Español']].map(([v, name]) =>
      h('option', { value: v, selected: state.settings.language === v }, name)));

  const theme = h('select', { onchange: (e) => { e.target.blur(); api.setSetting('theme', e.target.value); } },
    THEMES.map(([v, name]) => h('option', { value: v, selected: state.settings.theme === v }, name)));

  const contextWarn = h('select', { onchange: (e) => api.setSetting('contextWarn', Number(e.target.value)) },
    [0, 100000, 150000, 200000, 300000, 500000].map((v) =>
      h('option', { value: v, selected: state.settings.contextWarn === v }, v ? `${v / 1000}K · ${t(`ctxSize.${v}`)}${v === 500000 ? ` ★ ${t('recommended')}` : ''}` : t('off'))));
  // Real numbers from the user's own chats make the threshold easier to judge.
  const chats = [...state.stats.contexts].sort((a, b) => b.usedAt - a.usedAt).slice(0, 3)
    .map((c) => `${c.name} ${tokens(c.context)}`).join(' · ');

  // One tile per group of settings, with its name on top.
  const group = (title, ...rows) => h('section', { class: 'tile group' }, h('h3', {}, title), rows);
  setChildren(viewSettings,
    group(t('accounts'),
      state.profiles.map(profileEl),
      h('div', { class: 'row' }, newName, h('button', { class: 'primary', onclick: (e) => { e.target.blur(); add(); } }, t('add')))),
    group(t('behavior'),
      toggleRow('autoSwitch', t('optAutoSwitch')),
      toggleRow('compact', t('optCompact')),
      toggleRow('alwaysOnTop', t('optOnTop')),
      toggleRow('hideFromTaskbar', t('optTaskbar')),
      toggleRow('launchAtStartup', t('optStartup')),
      h('div', { class: 'row' }, h('label', {}, t('optRefresh')), picker(refresh)),
      h('div', { class: 'row' }, h('label', {}, t('optLanguage')), picker(language)),
      h('div', { class: 'row' }, h('label', {}, t('optTheme')), picker(theme)),
      state.glassOk && h('div', { class: 'row' },
        h('label', {}, t('optGlass')),
        // Blur first: its level shows up below, and the form is not rebuilt while in focus.
        h('input', { type: 'checkbox', checked: !!state.settings.glass, onchange: (e) => { e.target.blur(); api.setSetting('glass', e.target.checked); } })),
      glassOn() && h('div', { class: 'row' },
        h('label', {}, t('optGlassLevel')),
        h('input', {
          type: 'range', min: 10, max: 100, step: 5, value: state.settings.glassLevel, title: `${state.settings.glassLevel}%`,
          // Seen while it is dragged; kept when it is let go.
          oninput: (e) => document.documentElement.style.setProperty('--glass', e.target.value / 100),
          onchange: (e) => { e.target.blur(); api.setSetting('glassLevel', Number(e.target.value)); },
        }))),
    group(t('alerts'),
      toggleRow('alerts', t('optAlerts')),
      h('div', { class: 'row' },
        h('label', {}, t('optSound')),
        // Picking a sound plays it, so the list doubles as a preview.
        picker(h('select', { onchange: (e) => { playChime(e.target.value); api.setSetting('soundId', e.target.value); } },
          SOUNDS.map(([v, name]) => h('option', { value: v, selected: state.settings.soundId === v }, name)))),
        h('button', { class: 'ghost', title: t('soundTest'), onclick: (e) => { e.target.blur(); playChime(); } }, '▶'),
        h('input', { type: 'checkbox', checked: !!state.settings.sound, onchange: (e) => api.setSetting('sound', e.target.checked) })),
      h('div', { class: 'row' },
        h('label', {}, t('optVolume')),
        h('input', { type: 'range', min: 0, max: 100, step: 5, value: state.settings.volume, title: `${state.settings.volume}%`, onchange: (e) => { state.settings.volume = Number(e.target.value); playChime(); api.setSetting('volume', state.settings.volume); } })),
      h('div', { class: 'row' }, h('label', {}, t('warnAt')), numberInput('warnAt'), '%', numberInput('critAt'), '%'),
      h('div', { class: 'row' }, h('label', {}, t('optContext')), picker(contextWarn)),
      h('div', { class: 'note' }, t('ctxHelp')),
      chats && h('div', { class: 'note' }, t('ctxNow', { chats }))),
    h('footer', {}, `v${state.version} · ${t('footer')}`));
}

// ---------- tips ----------

// What saves the most, in order. Each has its drawing; titles and texts are in i18n.js
// under tips.h.<n>.…, by position.
const HABITS = ['newChat', 'flame', 'tidy', 'graph', 'gauge', 'plug', 'image', 'target'];
let openTip = null; // which habit is unfolded
let tipsAt = 0; // when the chats behind the tips were last read
let tipCopied = null; // id of the chat whose handoff prompt a tip just copied

// The tips read the same list of chats the Sessions panel does: now and then, or at once
// when asked to.
async function refreshTips(now) {
  if (!now && Date.now() - tipsAt < 120000) return;
  tipsAt = Date.now();
  try {
    sessions = await api.listSessions();
    render();
  } catch (err) {
    console.error('[chats]', err);
  }
}

// What this user could do right now, from what Tandem already measures: the account in
// use and the chats of the last day. Never a long list: two of a kind at most, and five
// in all, the most pressing ones first.
function personalTips() {
  const tips = [];
  const add = (id, lvl, vars, chat) => tips.push({ id, lvl, vars, chat });
  const recent = sessions.filter((s) => s.recent);
  const limit = state.settings.contextWarn || 500000;
  const long = recent.filter((s) => s.context >= limit).sort((a, b) => b.context - a.context);
  for (const s of long.slice(0, 2)) add('long', 'crit', { name: s.name, tokens: tokens(s.context) }, s);

  const active = state.accounts.find((a) => a.key === state.activeKey && a.status === 'ok');
  const session = active && active.metrics.find((m) => m.id === 'five_hour');
  if (session && session.fullAt) add('pace', 'warn', { account: active.label, when: fromNow(session.fullAt) });

  for (const s of recent) {
    if (long.includes(s)) continue;
    const setup = s.setup || {};
    const cold = s.cacheUntil && s.cacheUntil <= Date.now() && s.context >= 100000 && Date.now() - s.usedAt < 3 * 3600000;
    if (cold) add('cold', 'warn', { name: s.name, tokens: tokens(s.context) });
    if (['xhigh', 'max'].includes(setup.effort) || setup.ultracode) add('effort', 'warn', { name: s.name, effort: setup.ultracode ? 'ultracode' : setup.effort });
    if (setup.tools >= 100) add('tools', '', { name: s.name, n: setup.connectors, tools: setup.tools });
    if (s.images && s.images.count >= 20 && s.size && s.images.bytes / s.size >= 0.5) add('images', '', { name: s.name, n: s.images.count });
  }
  const off = new Map(recent.filter((s) => s.graphify && !s.graphify.enabled && !s.graphify.busy).map((s) => [s.root, s]));
  for (const s of off.values()) add('graphify', '', { project: s.project });

  const seen = {};
  const weight = { crit: 0, warn: 1, '': 2 };
  return tips
    .filter((tip) => (seen[tip.id] = (seen[tip.id] || 0) + 1) <= 2)
    .sort((a, b) => weight[a.lvl] - weight[b.lvl])
    .slice(0, 5);
}

// Makes the chat's handoff prompt and copies it, which is what a too-long chat needs.
// It only says so if there was a prompt to copy.
async function handOff(s) {
  sessions = await api.generatePrompts([s.id]);
  if (!(await api.copyPrompts([s.id]))) return render();
  tipCopied = s.id;
  render();
  setTimeout(() => {
    if (tipCopied !== s.id) return;
    tipCopied = null;
    render();
  }, 4000);
}

function renderTips() {
  const mine = personalTips();
  const before = places(viewTips);
  setChildren(viewTips,
    h('div', { class: 'tile tips-hero' },
      burstEl(),
      h('div', {}, h('h2', {}, t('tips.hook')), h('p', {}, t('tips.intro'))),
      pic.icon('bulb')()),
    h('h3', {}, t('tips.now')),
    !mine.length && h('div', { class: 'tile note' }, t('tips.nowNone')),
    mine.map((tip) => h('div', { class: `tile now-tip ${tip.lvl}` },
      h('strong', {}, t(`tips.p.${tip.id}.title`, tip.vars)),
      h('span', {}, t(`tips.p.${tip.id}.text`, tip.vars)),
      tip.chat && h('button', { class: 'primary', onclick: () => handOff(tip.chat) }, t(tipCopied === tip.chat.id ? 'tips.copied' : 'tips.copy')))),
    h('h3', {}, t('tips.habits')),
    h('div', { class: 'habits' }, HABITS.map((icon, i) => {
      const open = openTip === i;
      const habit = h('button', { class: `tile habit ${open ? 'open' : ''}`, onclick: () => { openTip = open ? null : i; render(); } },
        h('span', { class: 'habit-pic' }, pic.icon(icon)()),
        h('strong', {}, t(`tips.h.${i}.title`)),
        open && h('span', { class: 'habit-why' }, t(`tips.h.${i}.why`)),
        open && h('span', { class: 'habit-how' }, h('b', {}, t('tips.how')), ` ${t(`tips.h.${i}.how`)}`));
      return open ? arriving(`habit:${i}`, keyed(`habit:${i}`, habit)) : keyed(`habit:${i}`, habit);
    })));
  glide(viewTips, before);
}

// Pressing the button of the view that is already open goes back to the cards.
function setView(next) {
  if (view === 'guide') seenGuide();
  view = view === next ? 'usage' : next;
  paletteFor = null;
  render();
}

// ---------- guide ----------

// The tour for new users. Each page shows a working copy of one part of the app (its
// stage) and walks through its spots: an arrow points at one, and Tandem says below what
// it is for. Titles and texts are in i18n.js under g.<page>.…, by position.

// What the copies on the stages show. The tour's own buttons change it; the real app is
// never touched.
const DEMO = { used: 42, week: 78, size: 0.62, graphify: false, more: false };
let demo = { ...DEMO };
let guideSpot = 0; // which spot of the page the arrow is on
let guideDrawn = ''; // what the guide last drew: it is left alone while nothing changes
let guidePage = ''; // the page last drawn, so its entrance plays only once
let guideLit = null; // the element the arrow points at
let arrowShape = ''; // the arrow on screen, so the same one is not drawn again

const guideArrow = document.createElementNS(SVG, 'svg');
guideArrow.setAttribute('class', 'guide-arrow');
$('sheet').append(guideArrow);

// One leg of a rider, pedalling: from the hip on the saddle to the pedal, which goes round
// its crank, with the knee wherever that leaves it. The leg is drawn at sixteen moments of
// a turn and the page moves it from one to the next; `ahead` is how far round it starts.
const PEDAL = '1.1s';
function legEl(saddle, ahead, cls) {
  const hip = [saddle, 7];
  const crank = [saddle + 4, 23];
  const bone = 10.6; // thigh and shin alike
  const shapes = [];
  for (let i = 0; i <= 16; i++) {
    const turn = ahead + (i / 16) * 2 * Math.PI;
    const foot = [crank[0] + 4 * Math.cos(turn), crank[1] + 4 * Math.sin(turn)];
    const dx = foot[0] - hip[0];
    const dy = foot[1] - hip[1];
    const reach = Math.hypot(dx, dy);
    // The knee stands off the middle of the line from hip to foot, to the front.
    const off = Math.sqrt(Math.max(0, bone * bone - (reach / 2) ** 2)) / reach;
    const knee = [hip[0] + dx / 2 + dy * off, hip[1] + dy / 2 - dx * off];
    shapes.push(`M${hip} L${knee.map((n) => n.toFixed(2))} L${foot.map((n) => n.toFixed(2))}`);
  }
  return svgEl('path', { class: `g-leg ${cls}`, d: shapes[0] },
    !calm.matches && svgEl('animate', { attributeName: 'd', dur: PEDAL, repeatCount: 'indefinite', values: shapes.join(';') }));
}

// Tandem itself: a bicycle for two, with its wheels turning. `ride` puts its two riders
// on it, pedalling, which takes some room above the bicycle.
function tandemEl(cls = '') {
  const riding = cls === 'ride';
  const svg = svgEl('svg', { viewBox: riding ? '0 -12 64 46' : '0 0 64 34', class: `g-tandem ${cls}` });
  const riders = [[22, [31.5, 6.5]], [36, [45, 5]]]; // each one's saddle, and where the hands go
  // The legs on the far side go first, behind the bicycle.
  if (riding) riders.forEach(([saddle], who) => svg.append(legEl(saddle, Math.PI, `far r${who}`)));
  for (const x of [11, 53]) {
    svg.append(svgEl('g', { class: 'g-wheel' },
      svgEl('circle', { cx: x, cy: 23, r: 9 }),
      svgEl('path', { d: `M${x - 9} 23h18M${x} 14v18` })));
  }
  svg.append(svgEl('path', { d: 'M11 23H40M11 23L22.6 11H47M26 23L22 8M40 23L36 8M40 23L47 11M53 23L47 11L46 5M43 5h6.5M19.5 8h5M33.5 8h5' }));
  for (const x of [11, 53]) svg.append(svgEl('circle', { class: 'g-hub', cx: x, cy: 23, r: 2.4 }));
  if (!riding) return svg;
  // The second rider's handlebar, behind the first one's saddle.
  svg.append(svgEl('path', { d: 'M36 10L32 6.5M30.5 6.5h3' }));
  // Each rider wears one of the two colors of the logo's wheels (r0 and r1 in the styles).
  riders.forEach(([saddle, hand], who) => {
    const shoulder = [saddle + 6, -2.5];
    svg.append(
      svgEl('path', { class: 'g-crank', d: `M${saddle} 23h8` }),
      svgEl('path', { class: `g-torso r${who}`, d: `M${saddle} 7L${shoulder}` }),
      svgEl('path', { class: `g-arm r${who}`, d: `M${shoulder}L${[hand[0] + 0.5, hand[1] - 3.5]}L${hand}` }),
      svgEl('circle', { class: `g-head r${who}`, cx: saddle + 7.6, cy: -7, r: 2.7 }),
      legEl(saddle, 0, `r${who}`));
  });
  return svg;
}

// Marks a piece of a stage as the spot of that name: the arrow can point at it. Clicking
// it brings the arrow there, or does what the piece does in the real app.
function spotEl(name, el, act) {
  el.dataset.g = name;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (act) return act();
    const i = GUIDE[guideStep].spots.findIndex((spot) => spot.at === name);
    if (i >= 0 && i !== guideSpot) goGuide(guideStep, i);
  });
  return el;
}

// Changes what the stages show and draws them again.
function play(change) {
  change();
  render();
}

// The account on the stages, built like a real one so the real pieces can draw it.
function demoAccount() {
  const now = Date.now();
  const used = demo.used;
  return {
    key: 'demo', label: t('g.demo.account'), orgName: t('g.demo.org'), color: SWATCHES[0], status: 'ok',
    metrics: [
      {
        id: 'five_hour', pct: used, resetsAt: now + 130 * 60000,
        fullAt: used >= 60 && used < 100 ? now + (100 - used) * 90000 : null,
        pace: used < 60 ? { endPct: Math.round(used * 1.5) } : null,
      },
      {
        id: 'seven_day', pct: demo.week, resetsAt: now + 53 * 3600000,
        pace: { endPct: Math.min(99, demo.week + 14), perDay: Math.max(1, Math.round((100 - demo.week) / 3)) },
      },
    ],
  };
}

const demoLimit = () => state.settings.contextWarn || 500000;

// The account drawn with the pieces of a real one, open or closed.
function demoCard(a, active, collapsed) {
  const card = collapsed
    ? h('div', { class: 'account closed', color: a.color },
      identityEl(a, active),
      active ? spotEl('chips', chipsEl(a)) : chipsEl(a))
    : h('section', { class: 'account', color: a.color },
      h('div', { class: 'tile hero' }, burstEl(), identityEl(a, active)),
      spotEl('bars', h('div', { class: 'pair' }, a.metrics.map((m) => metricEl(m, a)))));
  const now = card.querySelector('.now');
  if (now) spotEl('inuse', now);
  return card;
}

function welcomeStage() {
  const a = demoAccount();
  const promise = (visual, n) => h('div', { class: 'g-promise', color: a.color },
    h('span', { class: 'g-tile' }, visual),
    h('span', {}, t(`g.welcome.row${n}`)));
  return [
    h('div', { class: 'g-hero' }, tandemEl('ride'), h('i', { class: 'g-road' })),
    promise(ringsEl(a), 0),
    promise(h('span', { class: 'g-now' }, t('active')), 1),
    promise(h('span', { class: 'g-swap' }, '⇄'), 2),
  ];
}

// An open card; for the spot about closed cards, the same one closed next to another.
function accountsStage() {
  const a = demoAccount();
  const closed = GUIDE[guideStep].spots[guideSpot].at === 'chips';
  const card = demoCard(a, true, closed);
  if (!closed) return card;
  const other = { ...a, label: t('g.demo.account2'), orgName: t('g.demo.org2'), color: SWATCHES[2], metrics: [{ ...a.metrics[0], pct: 12 }, { ...a.metrics[1], pct: 35 }] };
  return [card, demoCard(other, false, true)];
}

// A corner of the Windows desktop: the taskbar with Tandem's two icons next to the clock.
// First with what an icon says on hover, then with a notification popping up over it.
function trayStage() {
  const a = demoAccount();
  const s = state.settings;
  const now = new Date();
  const slot = (metric, solid, tip) => h('span', { class: `g-slot ${tip ? 'tip' : ''}` },
    h('img', { src: trayIcon(metric.pct, a.color, solid), alt: '' }),
    h('span', { class: 'g-tip' }, trayTip(a, metric)));
  // The slot keeps still while the notification slides into it, so the arrow lands right.
  const toast = guideSpot === 1 && spotEl('toast', h('div', { class: 'g-toast-slot' },
    h('div', { class: 'g-toast' },
      h('span', { class: 'g-toast-icon' }, tandemEl()),
      h('div', {},
        h('strong', {}, t('notifTitle', { label: a.label, metric: t('metric.five_hour'), pct: s.warnAt })),
        h('span', {}, t('notifBody', { org: a.orgName, threshold: s.warnAt }))))));
  return h('div', { class: 'g-desktop' },
    toast,
    h('div', { class: 'g-taskbar' },
      h('span', { class: 'g-chevron' }, '⌃'),
      spotEl('icons', h('span', { class: 'g-icons' },
        slot(a.metrics[0], false, guideSpot === 0),
        slot(a.metrics[1], true))),
      h('span', { class: 'g-clock' },
        h('span', {}, now.toLocaleTimeString(s.language, { hour: 'numeric', minute: '2-digit' })),
        h('span', {}, now.toLocaleDateString(s.language, { day: 'numeric', month: 'numeric', year: 'numeric' })))));
}

// One chat going through a handoff: first without a prompt, then with it made, copied
// and pasted in a new chat.
function sessionsStage() {
  const made = guideSpot > 0;
  return [
    h('div', { class: 'session' },
      h('div', { class: 'session-main' },
        h('div', { class: 'session-info' },
          h('span', { class: 'session-name' }, t('g.demo.chat')),
          h('span', { class: 'session-about' }, t('g.demo.folder')),
          h('span', { class: 'session-time' }, made ? t('promptCreated', { when: stamp(Date.now()) }) : t('lastUsed', { when: ago(Date.now() - 4 * 60000) }))),
        made && h('button', { class: 'primary' }, t('g.demo.copied')),
        spotEl('generate', h('button', { class: 'ghost' }, made ? '↻' : t('generate')), !made && (() => goGuide(guideStep, 1))))),
    spotEl('paste', h('div', { class: `g-chat ${made ? 'pasted' : ''}` },
      h('div', { class: 'g-chat-head' }, h('i', { color: SWATCHES[2] }), t('g.demo.newChat')),
      h('div', { class: 'g-chat-box' }, made ? h('span', { class: 'g-typed' }, t('g.demo.prompt')) : t('g.demo.paste')))),
  ];
}

// The lines under a chat, in the order the real ones come in.
function contextStage() {
  const limit = demoLimit();
  const context = Math.round(demo.size * limit);
  const lvl = demo.size >= 1 ? 'crit' : demo.size >= 0.75 ? 'warn' : '';
  const fill = h('div');
  fill.style.width = `${Math.min(100, demo.size * 50)}%`;
  const flip = (key) => () => play(() => { demo[key] = !demo[key]; });
  return h('div', { class: 'session' },
    h('div', { class: 'session-main' },
      h('div', { class: 'session-info' },
        h('span', { class: 'session-name' }, t('g.demo.chat')),
        h('span', { class: 'session-about' }, t('g.demo.folder')))),
    h('div', { class: 'session-context' },
      spotEl('size', h('div', { class: 'ctx-line' },
        h('span', { class: 'ctx-label' }, t('ctxWord')),
        h('div', { class: `bar ${lvl}` }, fill, h('i')),
        h('span', { class: `ctx-value ${lvl}` }, `${tokens(context)} / ${limit / 1000}K`))),
      demo.more && infoLine(t('costWord'), lvl, t('costPerMessage', { tokens: tokens(context * 2) })),
      infoLine(t('cacheWord'), '', t('cacheWarm', { m: 42 })),
      demo.more && [
        infoLine(t('modelWord'), '', `Opus · ${t('effortOf', { effort: 'high' })}`),
        infoLine(t('startWord'), '', `${t('startTokens', { tokens: '38K' })} · ${t('startConnectors', { n: 6 })}`),
        infoLine(t('imagesWord'), '', t('imagesText', { n: 14, pct: 31 })),
      ],
      spotEl('graphify', h('div', { class: 'ctx-line' },
        h('span', { class: 'ctx-label' }, 'Graphify'),
        h('span', { class: `ctx-state ${demo.graphify ? 'on' : ''}` }, t(demo.graphify ? 'graphifyOn' : 'graphifyOff')),
        h('button', { class: 'ghost', onclick: flip('graphify') }, t(demo.graphify ? 'graphifyTurnOff' : 'graphifyTurnOn')))),
      h('button', { class: 'ghost more', onclick: flip('more') }, demo.more ? `${t('less')} ▴` : `${t('more')} ▾`)));
}

const finaleStage = () => h('ol', { class: 'g-steps' }, [0, 1, 2].map((n) => h('li', {}, t(`g.finale.step${n}`))));

// Line drawings of what a spot is about, on a 24 × 24 grid.
const ICONS = {
  prompt: 'M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 15.5h5',
  newChat: 'M4 5h16v11h-9l-4 4v-4H4zM12 8v5M9.5 10.5h5',
  bill: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5zM9 8h6M9 12h6',
  graph: 'M3.7 7a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0-4.6 0M15.7 6a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0-4.6 0M9.4 17a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0-5.2 0M7 9l3.6 5.8M17 8.1l-3.6 6.7M8.3 6.8l7.4-.6',
  bell: 'M6 17v-6a6 6 0 0 1 12 0v6l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.3 1.1 2.2h5c0-.9.5-1.7 1.1-2.2A6 6 0 0 0 12 3z',
  flame: 'M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.2 2-4.2.2 1.6 1 2.4 1.8 2.6C10.5 8.5 11 5.5 12 3z',
  tidy: 'M4 9h16M4 15h16M9 3l3 3 3-3M9 21l3-3 3 3',
  gauge: 'M4 17a8 8 0 0 1 16 0M12 17l4-6M3 20h18',
  plug: 'M9 3v5M15 3v5M7 8h10v4a5 5 0 0 1-10 0zM12 17v4',
  image: 'M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5 5 5M15 9.5v.1',
  target: 'M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 12v.1',
};

// The small picture next to Tandem's words: what the spot is about. A drawing for an idea;
// for a control, a small copy of the control itself, showing what the stage shows.
const pic = {
  icon: (name) => () => {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'g-icon');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  },
  glyph: (text) => () => h('span', { class: 'g-glyph' }, text),
  bars: () => h('span', { class: 'g-minibars' }, demoAccount().metrics.map((m) => {
    const fill = h('div');
    fill.style.width = `${m.pct}%`;
    return h('div', { class: `bar ${level(m.pct)}` }, fill);
  })),
  inUse: () => h('span', { class: 'g-now', color: SWATCHES[0] }, t('active')),
  chips: () => {
    const chips = chipsEl(demoAccount());
    chips.classList.add('g-minichips');
    return chips;
  },
  trays: () => h('span', { class: 'g-minitrays' },
    [[demo.used, false], [demo.week, true]].map(([pct, solid]) => h('img', { src: trayIcon(pct, SWATCHES[0], solid), alt: '' }))),
};

// The pages and their spots. `at` is the piece of the stage the arrow points at, or the
// id of a control of the real header; `pic` draws the picture next to the words. A `quiet`
// spot has no words: the page says it all. `try` is what the spot's own button does;
// while `on` holds, the texts listed in `swap` use their second version (…On in i18n.js).
const GUIDE = [
  { id: 'welcome', stage: welcomeStage, spots: [{ quiet: true }] },
  { id: 'accounts', stage: accountsStage, spots: [
    {
      at: 'bars', pic: pic.bars, on: () => demo.used >= 100, swap: ['text', 'try'],
      try: () => {
        const full = demo.used >= 100;
        demo.used = full ? DEMO.used : Math.min(100, demo.used + 20);
        demo.week = full ? DEMO.week : Math.min(100, demo.week + 5);
      },
    },
    { at: 'inuse', pic: pic.inUse },
    { at: 'chips', pic: pic.chips },
  ] },
  { id: 'tray', stage: trayStage, spots: [
    { at: 'icons', pic: pic.trays },
    { at: 'toast', pic: pic.icon('bell'), try: () => playChime() },
  ] },
  { id: 'sessions', stage: sessionsStage, spots: [
    { at: 'generate', pic: pic.icon('prompt') },
    { at: 'paste', pic: pic.icon('newChat') },
  ] },
  { id: 'context', stage: contextStage, spots: [
    {
      at: 'size', pic: pic.icon('bill'), on: () => demo.size >= 1, swap: ['text', 'try'],
      try: () => { demo.size = demo.size >= 1 ? 0.06 : demo.size + 0.22; },
    },
    { at: 'graphify', pic: pic.icon('graph'), on: () => demo.graphify, swap: ['try'], try: () => { demo.graphify = !demo.graphify; } },
  ] },
  { id: 'finale', stage: finaleStage, spots: [{ at: '#btn-settings', pic: pic.glyph('⚙') }] },
];

// Leaving the guide once is what marks it as seen, so it does not open by itself again.
function seenGuide() {
  if (!state.settings.guideSeen) api.setSetting('guideSeen', true);
}

function goGuide(step, spot = 0) {
  guideStep = step;
  guideSpot = spot;
  render();
  viewGuide.scrollTop = 0;
}

// One step on or back: the next spot of the page, then the next page.
function stepGuide(dir) {
  const spot = guideSpot + dir;
  if (spot >= 0 && spot < GUIDE[guideStep].spots.length) return goGuide(guideStep, spot);
  const step = guideStep + dir;
  if (step >= GUIDE.length) return closeGuide();
  if (step >= 0) goGuide(step, dir > 0 ? 0 : GUIDE[step].spots.length - 1);
}

// Where Skip and the last Next lead. A new user has no account yet, so the guide leaves
// them where one is added.
function closeGuide() {
  seenGuide();
  guideStep = 0;
  guideSpot = 0;
  demo = { ...DEMO };
  view = state.accounts.length ? 'usage' : 'settings';
  render();
}

// Out of the guide nothing of it may stay on screen: neither the arrow nor the light on
// a control of the real header.
function leaveGuide() {
  if (!guideDrawn) return;
  guideDrawn = '';
  guidePage = '';
  light(null);
}

// Lights up what the spot is about and, once the page is laid out, draws the arrow to it.
function light(at) {
  if (guideLit) guideLit.classList.remove('g-on');
  guideLit = !at ? null : at[0] === '#' ? document.querySelector(at) : viewGuide.querySelector(`[data-g="${at}"]`);
  if (guideLit) guideLit.classList.add('g-on');
  requestAnimationFrame(pointAt);
}

// The arrow comes up from Tandem's bubble and lands under the piece it points at. A
// control of the real header is pointed at from the end of the title, right below it.
function pointAt() {
  let d = '';
  let x;
  let y;
  if (view === 'guide' && guideLit && guideLit.isConnected) {
    // Everything is measured from the panel's corner, where the arrow is drawn.
    const origin = $('sheet').getBoundingClientRect();
    const box = (rect) => ({ left: rect.left - origin.left, right: rect.right - origin.left, top: rect.top - origin.top, bottom: rect.bottom - origin.top, width: rect.width, height: rect.height });
    const to = box(guideLit.getBoundingClientRect());
    x = to.left + to.width / 2;
    y = to.bottom + 6;
    if (viewGuide.contains(guideLit)) {
      const from = box(viewGuide.querySelector('.guide-bubble').getBoundingClientRect());
      const rise = from.top - y;
      const lean = Math.min(46, Math.max(12, rise * 0.7)) * (x < from.left + from.width / 2 ? 1 : -1);
      const x0 = Math.min(from.right - 24, Math.max(from.left + 24, x + lean));
      d = `M${x0} ${from.top - 2}C${x0} ${from.top - rise * 0.5} ${x} ${y + rise * 0.6} ${x} ${y}`;
    } else {
      const line = box(viewGuide.querySelector('.guide-head h2 span').getClientRects()[0]);
      const x0 = Math.min(line.right + 10, origin.width - 44);
      const y0 = line.top + line.height / 2;
      d = `M${x0} ${y0}C${x0 + 26} ${y0} ${x} ${y + 24} ${x} ${y}`;
    }
  }
  if (d === arrowShape) return;
  arrowShape = d;
  guideArrow.replaceChildren();
  if (!d) return;
  const path = (cls, shape) => {
    const el = document.createElementNS(SVG, 'path');
    el.setAttribute('class', cls);
    el.setAttribute('d', shape);
    el.setAttribute('pathLength', 1);
    guideArrow.append(el);
  };
  path('halo', d);
  path('line', d);
  path('head', `M${x - 5} ${y + 7}L${x} ${y}L${x + 5} ${y + 7}`);
}

// Bars drawn again grow from where they were instead of jumping.
function growBars(stage, before) {
  if (calm.matches) return;
  stage.querySelectorAll('.bar > div').forEach((fill, i) => {
    const to = fill.style.width;
    if (!before[i] || before[i] === to) return;
    fill.style.width = before[i];
    fill.getBoundingClientRect(); // the old width has to be laid out before the new one
    fill.style.transition = 'width 0.45s ease';
    fill.style.width = to;
  });
}

function renderGuide() {
  const s = state.settings;
  const drawn = JSON.stringify([guideStep, guideSpot, demo, s.language, s.theme, s.warnAt, s.critAt, s.contextWarn, state.accounts.length]);
  if (drawn === guideDrawn) return;
  guideDrawn = drawn;

  const page = GUIDE[guideStep];
  const spot = page.spots[guideSpot];
  const first = !guideStep && !guideSpot;
  const last = guideStep === GUIDE.length - 1 && guideSpot === page.spots.length - 1;
  const on = spot.on ? spot.on() : false;
  // The marks named in the texts are the ones this user has set.
  const say = (part) => t(`g.${page.id}.${guideSpot}.${part}${on && spot.swap.includes(part) ? 'On' : ''}`, { warn: s.warnAt, crit: s.critAt });
  const enter = guidePage === page.id ? '' : 'enter';
  const old = !enter && viewGuide.querySelector('.guide-stage');
  const before = old ? [...old.querySelectorAll('.bar > div')].map((fill) => fill.style.width) : [];
  guidePage = page.id;

  const stage = h('div', { class: `guide-stage ${enter}` }, page.stage());
  const intro = page.id === 'finale' && state.accounts.length ? 'introHave' : 'intro';
  setChildren(viewGuide,
    h('div', { class: `guide-head ${enter}` },
      h('h2', {}, h('span', {}, t(`g.${page.id}.hook`))),
      h('div', { class: 'guide-intro' }, t(`g.${page.id}.${intro}`))),
    stage,
    !spot.quiet && h('div', { class: `guide-bubble ${spot.at[0] === '#' ? 'calm' : ''}` },
      h('div', { class: 'guide-pic' }, spot.pic()),
      h('div', { class: 'guide-say' },
        h('strong', {}, say('name')),
        h('span', {}, say('text')),
        (spot.try || page.spots.length > 1) && h('div', { class: 'guide-extra' },
          spot.try && h('button', { class: 'primary guide-try', onclick: () => play(spot.try) }, say('try')),
          page.spots.length > 1 && h('div', { class: 'guide-pips' },
            page.spots.map((_, i) => h('button', { class: i === guideSpot ? 'on' : '', onclick: () => goGuide(guideStep, i) })))))),
    // Skip and Back keep their place when they have nothing to do, so the rest stays put.
    h('div', { class: 'guide-nav' },
      h('button', { class: `ghost guide-skip ${last ? 'gone' : ''}`, title: t('guideSkipTip'), onclick: closeGuide }, t('guideSkip')),
      h('div', { class: 'guide-dots' },
        GUIDE.map((p, i) => h('button', { class: i === guideStep ? 'on' : '', title: t(`g.${p.id}.hook`), onclick: () => goGuide(i) }))),
      h('button', { class: `ghost guide-back ${first ? 'gone' : ''}`, title: t('guideBack'), onclick: () => stepGuide(-1) }, '‹'),
      h('button', { class: 'primary', onclick: () => stepGuide(1) }, t(last ? 'guideDone' : 'guideNext'))));
  growBars(stage, before);
  light(spot.at);
}

// ---------- tray icon ----------

// Two tray icons for the account in use: its session limit (outlined) and its weekly
// limit (solid). The box is colored by how much is used, like the bars (see level());
// the stripe underneath is the account's own color, so you can tell which account it is.
function trayIcon(pct, accountColor, solid) {
  const size = 64;
  const boxHeight = 49;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const theme = getComputedStyle(document.documentElement);
  const lvl = pct == null ? '' : level(pct);
  const status = pct == null ? '#a3a3a3' : theme.getPropertyValue(lvl ? `--${lvl}` : '--ok').trim();

  ctx.fillStyle = status;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, boxHeight, 12);
  ctx.fill();
  if (!solid) {
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.roundRect(6, 6, size - 12, boxHeight - 12, 7);
    ctx.fill();
  }
  const text = pct == null ? '–' : String(pct);
  ctx.fillStyle = solid ? '#1a1a1a' : status;
  ctx.font = `700 ${text.length > 2 ? 28 : 36}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, boxHeight / 2 + 2);

  ctx.fillStyle = accountColor;
  ctx.beginPath();
  ctx.roundRect(0, boxHeight + 4, size, size - boxHeight - 4, 5);
  ctx.fill();
  return canvas.toDataURL('image/png');
}

// What a tray icon says on hover: the metric and, on a second line, when it resets.
function trayTip(account, metric) {
  const lines = [`${account.label} — ${t(`metric.${metric.id}`)}: ${metric.pct}%`];
  if (metric.resetsAt) {
    const reset = `${untilReset(metric.resetsAt)} · ${clock(metric.resetsAt)}`;
    lines.push(reset[0].toUpperCase() + reset.slice(1));
  }
  return lines.join('\n');
}

function drawTray() {
  const active = state.accounts.find((a) => a.key === state.activeKey && a.status === 'ok' && a.metrics.length);
  const color = active ? active.color : '#a3a3a3';
  const pick = (id, fallback) => active && (active.metrics.find((m) => m.id === id) || active.metrics[fallback]);
  const slots = [['session', pick('five_hour', 0), false], ['weekly', pick('seven_day', 1), true]];
  api.trayImages(slots.map(([key, metric, solid]) => ({
    key,
    dataUrl: trayIcon(metric ? metric.pct : null, color, solid),
    tip: metric ? trayTip(active, metric) : 'Tandem - Claude Usage',
  })));
}

// ---------- wiring ----------

// Draws everything again. A failure in it is logged and left there: thrown further, it
// would also stop whatever called it, the tray icons among them.
function render() {
  if (!state) return;
  try {
    draw();
  } catch (err) {
    console.error('[render]', err);
  }
}

function draw() {
  viewUsage.hidden = view !== 'usage';
  viewSettings.hidden = view !== 'settings';
  viewGuide.hidden = view !== 'guide';
  viewTips.hidden = view !== 'tips';
  // The bulb is lit while Tandem has something to say about this user's own chats.
  const mine = personalTips().length;
  $('btn-tips').title = mine ? t('tipsSome', { n: mine }) : t('tips');
  $('btn-tips').classList.toggle('lit', mine > 0);
  $('btn-tips').classList.toggle('on', view === 'tips');
  document.documentElement.lang = state.settings.language;
  document.documentElement.dataset.theme = state.settings.theme;
  // With the glass on, the panel and its tiles let through that much of what is behind.
  document.documentElement.classList.toggle('glass', glassOn());
  document.documentElement.style.setProperty('--glass', glassOn() ? state.settings.glassLevel / 100 : 0);
  $('btn-guide').title = t('guide');
  $('btn-guide').classList.toggle('on', view === 'guide');
  $('auto-badge').title = t('autoSwitchTip');
  $('btn-refresh').title = t('refresh');
  $('btn-settings').title = t('settings');
  $('btn-hide').title = t('hide');
  $('auto-badge').classList.toggle('off', !state.settings.autoSwitch);
  $('btn-settings').classList.toggle('on', view === 'settings');
  $('btn-refresh').classList.toggle('spinning', state.refreshing);
  // The view that has just been opened comes in animated; the tour has its own entrance.
  for (const [name, el] of [['usage', viewUsage], ['settings', viewSettings], ['tips', viewTips]]) {
    if (view === name) arriving(`view:${name}`, el);
    else el.classList.remove('arrive');
  }
  // Rebuilding the settings form would drop what is being typed, picked or dragged in it,
  // so it waits while one of those controls has the focus. A button or a tick does not
  // hold it up: what they change has to show.
  const busy = document.activeElement;
  const typing = viewSettings.contains(busy) && busy.matches('input[type="text"], input[type="number"], input[type="range"], select');
  if (view === 'settings' && !typing) renderSettings();
  // Same for the inline name editor on a card. What is on screen then has not gone away.
  if (view === 'usage' && !document.querySelector('.name-edit:focus')) renderUsage();
  else if (view === 'usage') for (const key of arrivals.keys()) arrived.add(key);
  if (view === 'guide') renderGuide();
  else leaveGuide();
  if (view === 'tips') renderTips();
  settleArrivals();
}

$('btn-tips').append(pic.icon('bulb')());
$('btn-tips').addEventListener('click', () => {
  setView('tips');
  if (view === 'tips') refreshTips(true);
});
$('btn-guide').addEventListener('click', () => setView('guide'));
// The arrow follows what it points at when the page scrolls or the window changes size.
viewGuide.addEventListener('scroll', pointAt);
window.addEventListener('resize', pointAt);
document.addEventListener('keydown', (e) => {
  if (view !== 'guide' || !['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
  stepGuide(e.key === 'ArrowRight' ? 1 : -1);
});
$('btn-refresh').addEventListener('click', () => api.refresh());
$('btn-hide').addEventListener('click', () => api.hide());
api.onPickSession(openActiveSessions);
api.onPlaySound(() => playChime());
$('btn-settings').addEventListener('click', () => setView('settings'));
$('auto-badge').addEventListener('click', () => state && api.setSetting('autoSwitch', !state.settings.autoSwitch));

// ---------- the panel's size ----------

// The window does not change size with what it shows; the panel does, sliding. When what it
// holds gets taller or shorter, the frame takes the taller of the two sizes and the panel
// slides inside it from one to the other: its top edge travels, its bottom stays put, and
// what does not fit yet is hidden below the frame. The page animates that itself, frame by
// frame and in fractions of a pixel, which a real window cannot do.
const FIT = { duration: 620, easing: 'cubic-bezier(0.3, 0.2, 0.1, 1)', fill: 'forwards' };
const frame = $('app');
const sheet = $('sheet');
// The glass is Windows' own, and not every Windows has it (state.glassOk).
const glassOn = () => Boolean(state && state.settings.glass && state.glassOk);
let fitting = null; // the slide under way
let fitted = 0; // the height the panel has, or is on its way to
let span = 0; // how tall the frame is during the slide: the taller of its two ends

// How tall the panel is on screen right now, even midway through a slide. By the time a
// new size is known the panel has already been laid out with it, so this is worked out
// from the last one and, during a slide, from how far it has got.
const shownHeight = () => (fitting ? span - new DOMMatrix(getComputedStyle(sheet).transform).m42 : fitted);

function fit() {
  const to = $('content').offsetHeight;
  if (to === fitted) return;
  const from = Math.round(shownHeight());
  fitted = to;
  const rest = () => {
    if (fitting) fitting.cancel();
    fitting = null;
    frame.style.height = '';
    sheet.style.minHeight = '';
    api.resize(to);
    if (glassOn()) api.glass(to);
  };
  // Nothing to slide: the first size, a change of a few pixels, or less motion asked for.
  if (!from || Math.abs(to - from) < 12 || calm.matches) return rest();
  if (fitting) fitting.cancel();
  span = Math.max(from, to);
  frame.style.height = `${span}px`;
  sheet.style.minHeight = `${span}px`;
  // While it slides, the window takes the mouse over the whole of the taller size.
  api.resize(span);
  const slide = sheet.animate([{ transform: `translateY(${span - from}px)` }, { transform: `translateY(${span - to}px)` }], FIT);
  fitting = slide;
  // Only the slide still under way may put the panel to rest at its own size.
  slide.onfinish = () => { if (fitting === slide) rest(); };
  if (!glassOn()) return;
  // The glass behind the panel is a window of its own, which has to be told the panel's
  // height at every frame of the slide. It must never show above the panel's top edge,
  // and word of it takes a moment to arrive: on the way down it is sent where the panel
  // will be shortly, and on the way up, where it was a moment ago.
  const start = performance.now();
  const lead = to < from ? 70 : -24;
  const follow = (now) => {
    if (fitting !== slide) return;
    const at = Math.min(1, Math.max(0, (now - start + lead) / FIT.duration));
    api.glass(Math.floor(from + (to - from) * easeFit(at)));
    requestAnimationFrame(follow);
  };
  requestAnimationFrame(follow);
}

// The curve of FIT.easing, cubic-bezier(0.3, 0.2, 0.1, 1), worked out by hand: how far
// along the slide is at a given moment of it.
function easeFit(time) {
  const along = (a, b, s) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s ** 2 * b + s ** 3;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    if (along(0.3, 0.1, mid) < time) low = mid;
    else high = mid;
  }
  return along(0.2, 1, (low + high) / 2);
}

new ResizeObserver(fit).observe($('content'));
setInterval(() => {
  if (view !== 'settings') render();
  // Keeps the countdown in the tray tooltips current between refreshes.
  if (state) drawTray();
}, 30000);

api.onState((next) => {
  const first = !state;
  state = next;
  // Someone who has never closed the guide starts on it.
  if (first && !state.settings.guideSeen) view = 'guide';
  render();
  drawTray();
  // An open list of chats follows what changed since it was opened: last use, size, cache.
  // The tips read the same list, so with it open they are served by the same reading.
  refreshTips(Boolean(sessionsFor));
});
api.ready();
