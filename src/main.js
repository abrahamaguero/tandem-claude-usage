const { app, BaseWindow, BrowserWindow, WebContentsView, Tray, Menu, ipcMain, dialog, session, nativeImage, nativeTheme, Notification, screen, clipboard, shell, net } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { translate, languages } = require('./i18n');
const { buildHandoff, listSessions } = require('./handoff');
const { appSessions, chatSetup } = require('./claude-app');
const { createHistory, projectFull, recentRate, downsample, tokenStats, contextOf, modelName } = require('./insights');
const { readJson, writeJson } = require('./store');
const graphify = require('./graphify');

const BASE = 'https://claude.ai';
// Claude Code (CLI) records the account it is signed in to here.
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const WIDTH = 460;
const COLORS = ['#e91e8c', '#00a0b0', '#d4ff00', '#ffffff'];
const METRIC_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps', 'extra_usage'];
const DEFAULT_SETTINGS = {
  autoSwitch: true,
  launchAtStartup: true,
  alwaysOnTop: true,
  hideFromTaskbar: true,
  compact: true,
  alerts: true,
  warnAt: 75,
  critAt: 90,
  refreshSec: 60,
  language: 'en',
  theme: 'obsidian',
  sound: true,
  soundId: 'pop',
  volume: 15,
  contextWarn: 500000,
  // False until the guide for new users has been closed once.
  guideSeen: false,
  glass: false,
  glassLevel: 60,
  checkUpdates: true,
  ownAlerts: true,
};

let config;
const t = (key, vars) => translate(config.settings.language, key, vars);
let win;
const trays = new Map(); // slot ('session' | 'weekly') -> Tray
const trayTips = new Map();
let quitting = false;
let pollTimer;
let refreshing = false;
let handoffNotified = null;
let sessionRows = [];
let history;
let stats = { byAccount: {}, contexts: [] };
const contextNotified = new Set();
const projectionNotified = new Set();

const MIN = 60 * 1000;
// How far back to look, and the least history needed, before projecting each limit.
const PROJECTION = { five_hour: { window: 45 * MIN, minSpan: 5 * MIN }, default: { window: 12 * 60 * MIN, minSpan: 60 * MIN } };

// Runtime (not persisted) per-account data, keyed by `${profileId}:${orgUuid}`.
const usage = new Map();
const prevTotals = new Map();
const alertLevels = new Map();
const profileStatus = new Map(); // profileId -> 'ok' | 'login' | 'error'
const workers = new Map(); // profileId -> { win, queue }
const loginWindows = new Map();

// ---------- config ----------

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// The language of the system, when Tandem speaks it: the one a new install starts in.
// "es-419" is served by "es", and "pt-PT" by the Portuguese there is.
function systemLanguage() {
  const base = (code) => code.toLowerCase().split('-')[0];
  for (const wanted of [...app.getPreferredSystemLanguages(), app.getLocale()]) {
    const match = languages.find((code) => code.toLowerCase() === wanted.toLowerCase()) || languages.find((code) => base(code) === base(wanted));
    if (match) return match;
  }
  return DEFAULT_SETTINGS.language;
}

function loadConfig() {
  // A damaged config.json falls back to the last good copy instead of starting empty,
  // which would drop the accounts on the next save.
  const saved = readJson(configPath()) || {};
  const blank = { profiles: [], activeKey: null, viewKey: null, inUse: { uuid: null, cli: null, desktopT: 0 }, lastActivity: {}, switchLog: [], bounds: null };
  config = { ...blank, ...saved, settings: { ...DEFAULT_SETTINGS, language: systemLanguage(), ...saved.settings } };
  // The file may have been edited by hand or written by another version: anything that
  // does not have the shape the rest of the app counts on goes back to its default.
  const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);
  config.profiles = (Array.isArray(config.profiles) ? config.profiles : [])
    .filter((p) => plain(p) && typeof p.id === 'string' && typeof p.partition === 'string')
    .map((p) => ({ ...p, orgs: (Array.isArray(p.orgs) ? p.orgs : []).filter((o) => plain(o) && typeof o.uuid === 'string') }));
  if (!Array.isArray(config.switchLog)) config.switchLog = [];
  if (!plain(config.lastActivity)) config.lastActivity = {};
  if (!plain(config.inUse)) config.inUse = blank.inUse;
  if (!plain(config.bounds) || !Number.isFinite(config.bounds.x) || !Number.isFinite(config.bounds.y)) config.bounds = null;
  for (const [name, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (typeof config.settings[name] !== typeof value) config.settings[name] = value;
  }
  if (!languages.includes(config.settings.language)) config.settings.language = DEFAULT_SETTINGS.language;
}

// A save that fails (the disk is full, an antivirus holds the file) must not take the app
// down with it: what is in memory stays good, and the next save tries again.
function saveConfig() {
  try {
    writeJson(configPath(), config, 2);
  } catch (err) {
    console.error('[config]', err.message);
  }
}

// The main window, as long as it is there to be used. Timers, the tray and notifications
// outlive it while the app is closing.
const alive = () => Boolean(win) && !win.isDestroyed();

// A session never gets what a web page may ask the system for (camera, location, opening
// other programs...): neither claude.ai nor the app's own page needs any of it.
function lockDown(ses) {
  ses.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  ses.setPermissionCheckHandler(() => false);
}

// ---------- claude.ai access ----------

// Requests go through a hidden window that navigates to the API URL, so they carry
// the profile's cookies and pass the same checks a normal browser tab does.
function getWorker(profile) {
  // No new window for an account that was just removed, or while the app is closing.
  if (quitting || !config.profiles.includes(profile)) throw new Error('gone');
  let worker = workers.get(profile.id);
  if (!worker || worker.win.isDestroyed()) {
    lockDown(session.fromPartition(profile.partition));
    const w = new BrowserWindow({
      show: false,
      webPreferences: { partition: profile.partition, sandbox: true, contextIsolation: true, images: false },
    });
    // It only ever reads claude.ai: nothing may take it elsewhere or open another window.
    const stay = (e, url) => { if (!url.startsWith(`${BASE}/`)) e.preventDefault(); };
    w.webContents.on('will-navigate', stay);
    w.webContents.on('will-redirect', stay);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    worker = { win: w, queue: Promise.resolve() };
    workers.set(profile.id, worker);
  }
  return worker;
}

function timeout(promise, ms) {
  return Promise.race([promise, new Promise((_r, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

function apiGet(profile, apiPath) {
  const worker = getWorker(profile);
  const run = async () => {
    const wc = worker.win.webContents;
    let status = 0;
    const onNavigate = (_e, _url, code) => { status = code; };
    wc.on('did-navigate', onNavigate);
    try {
      await timeout(wc.loadURL(BASE + apiPath), 25000);
      const read = () => wc.executeJavaScript('document.body ? document.body.innerText : ""');
      let text = await read();
      let json = parseJson(text);
      if (!json && status !== 200) {
        // Possibly an interstitial that resolves itself; give it one chance.
        await new Promise((r) => setTimeout(r, 6000));
        text = await read();
        json = parseJson(text);
      }
      return { status, json };
    } finally {
      wc.removeListener('did-navigate', onNavigate);
    }
  };
  // The whole request has a limit, not just loading the page: one that never answered
  // would hold up every later one, and with them the refresh itself.
  const limited = () => timeout(run(), 45000);
  const result = worker.queue.then(limited, limited);
  worker.queue = result.catch(() => {});
  return result;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function hasSession(profile) {
  const cookies = await session.fromPartition(profile.partition).cookies.get({ url: BASE, name: 'sessionKey' });
  return cookies.length > 0;
}

async function loadOrgs(profile) {
  const { status, json } = await apiGet(profile, '/api/organizations');
  if (!Array.isArray(json)) {
    if (status === 401 || status === 403) return 'login';
    throw new Error(t('errUnexpected', { status }));
  }
  const chatOrgs = json.filter((o) => (o.capabilities || []).some((c) => c !== 'api'));
  const orgs = (chatOrgs.length ? chatOrgs : json).map((o) => {
    const known = profile.orgs.find((k) => k.uuid === o.uuid);
    return { uuid: o.uuid, name: o.name || t('orgDefault'), enabled: known ? known.enabled : true, alias: known ? known.alias : '', color: known ? known.color : null, removed: known ? !!known.removed : false };
  });
  profile.orgs = orgs;
  saveConfig();
  return 'ok';
}

function extractMetrics(json) {
  const metrics = [];
  for (const [id, value] of Object.entries(json || {})) {
    if (value && typeof value === 'object' && typeof value.utilization === 'number') {
      metrics.push({
        id,
        pct: Math.round(value.utilization),
        resetsAt: value.resets_at || null,
      });
    }
  }
  const rank = (m) => (METRIC_ORDER.includes(m.id) ? METRIC_ORDER.indexOf(m.id) : METRIC_ORDER.length);
  return metrics.sort((a, b) => rank(a) - rank(b));
}

async function refreshProfile(profile) {
  if (!(await hasSession(profile))) {
    profileStatus.set(profile.id, 'login');
    return;
  }
  if (!profile.orgs.length || profileStatus.get(profile.id) !== 'ok') {
    const result = await loadOrgs(profile);
    profileStatus.set(profile.id, result);
    if (result !== 'ok') return;
  }
  for (const org of profile.orgs.filter((o) => o.enabled && !o.removed)) {
    const key = `${profile.id}:${org.uuid}`;
    try {
      const { status, json } = await apiGet(profile, `/api/organizations/${org.uuid}/usage`);
      if (status === 401) {
        profileStatus.set(profile.id, 'login');
        return;
      }
      if (status !== 200 || !json) throw new Error(t('errNoUsage', { status }));
      const metrics = extractMetrics(json);
      recordSample(key, profile, org, metrics);
      history.add(key, metrics);
      usage.set(key, { metrics, extra: json.extra_usage || null, fetchedAt: Date.now(), error: null });
    } catch (err) {
      usage.set(key, { ...(usage.get(key) || { metrics: [] }), error: err.message });
    }
  }
}

// Something to tell the user: Tandem's own alert above its icons or, with that turned off,
// a notification of Windows. Either way the caller gets something to hang a click on and to
// show. Notifications are always silent for Windows; the app plays its own chime instead.
// Each one is held on to until it is closed: let go of, a click on it would no longer be heard.
const notifications = new Set();
function createNotification(options) {
  if (config.settings.sound && alive()) win.webContents.send('play-sound');
  if (config.settings.ownAlerts) return ownAlert(options);
  // What the alert is about and how pressing it is are for Tandem's own alerts to draw.
  const { kind, level, meters, ...words } = options;
  const notification = new Notification({ ...words, silent: true });
  notifications.add(notification);
  notification.on('close', () => notifications.delete(notification));
  return notification;
}

// ---------- Tandem's own alerts ----------

// Windows shows its notifications where it sees fit. Tandem's own go in a small window of
// their own, right above its icons in the taskbar, one at a time: the page of that window
// is given the words, answers with how tall they came out, is placed and shown, and says
// when the alert is gone (alert.js).
const ALERT_WIDTH = 348;
const ALERT_MS = 8000;
const ALERT_GAP = 5; // between the alert, pointer included, and the edge of the screen's free area
let alertWin = null;
let alertLoaded = false;
let alertNow = null; // the alert on screen or on its way there: { title, body, click }
const alertQueue = [];

// Stands in for a notification of Windows: the same two things are asked of it.
function ownAlert({ title, body, kind, level, meters }) {
  const alert = { title: String(title || ''), body: String(body || ''), kind, level, meters: meters || [], click: null };
  return {
    on(event, handler) {
      if (event === 'click') alert.click = handler;
      return this;
    },
    show() {
      alertQueue.push(alert);
      // Never a long line of them: the oldest that has not been shown gives way.
      if (alertQueue.length > 4) alertQueue.shift();
      if (!alertNow) nextAlert();
    },
  };
}

function nextAlert() {
  alertNow = alertQueue.shift() || null;
  if (quitting) return;
  if (!alertNow) {
    if (alertWin && !alertWin.isDestroyed()) alertWin.hide();
    return;
  }
  if (!alertWin || alertWin.isDestroyed()) {
    alertLoaded = false;
    alertWin = new BrowserWindow({
      width: ALERT_WIDTH,
      height: 96,
      frame: false,
      transparent: true,
      thickFrame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // It may take the keyboard, though only when pressed: it is shown without it
      // (showInactive). A window that may never have it gets no press of the mouse from
      // Windows, only the release, and its buttons cannot be clicked.
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'alert-preload.js'),
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    alertWin.setAlwaysOnTop(true, 'pop-up-menu');
    const page = alertWin.webContents;
    page.on('will-navigate', (e, url) => { if (url !== page.getURL()) e.preventDefault(); });
    page.setWindowOpenHandler(() => ({ action: 'deny' }));
    page.on('did-finish-load', () => {
      alertLoaded = true;
      sayAlert();
    });
    alertWin.on('closed', () => { alertWin = null; });
    alertWin.loadFile(path.join(__dirname, 'renderer', 'alert.html'));
    return;
  }
  sayAlert();
}

function sayAlert() {
  if (!alertNow || !alertLoaded || !alertWin || alertWin.isDestroyed()) return;
  const { title, body, kind, level, meters } = alertNow;
  alertWin.webContents.send('say', { title, body, kind, level, meters, theme: config.settings.theme, language: config.settings.language, ms: ALERT_MS });
}

// Where an alert that came out `height` tall goes. Above Tandem's icons when they are
// on a taskbar, with `tail` saying how far from the alert's left edge they are; in the
// corner by the clock when the icons are tucked away among the hidden ones.
function alertPlace(height) {
  const icons = [...trays.values()].map((tray) => tray.getBounds()).filter((b) => b.width > 0 && b.height > 0);
  const corner = (area) => ({ x: area.x + area.width - ALERT_WIDTH - ALERT_GAP, y: area.y + area.height - height - ALERT_GAP, tail: null });
  if (!icons.length) return corner(screen.getPrimaryDisplay().workArea);
  const left = Math.min(...icons.map((b) => b.x));
  const right = Math.max(...icons.map((b) => b.x + b.width));
  const cx = (left + right) / 2;
  const cy = icons[0].y + icons[0].height / 2;
  const area = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) }).workArea;
  const inside = cx >= area.x && cx < area.x + area.width && cy >= area.y && cy < area.y + area.height;
  // Not on a taskbar: the icons are in the box of hidden ones, which may not even be open.
  if (inside) return corner(area);
  const within = (value, low, high) => Math.round(Math.max(low, Math.min(value, high)));
  const x = within(cx - ALERT_WIDTH / 2, area.x + ALERT_GAP, area.x + area.width - ALERT_WIDTH - ALERT_GAP);
  const y = within(cy - height / 2, area.y + ALERT_GAP, area.y + area.height - height - ALERT_GAP);
  // The pointer is drawn under the alert, so only a taskbar below it gets one.
  const below = cy >= area.y + area.height;
  return { x, y, tail: below ? within(cx - x, 28, ALERT_WIDTH - 28) : null };
}

// The alert's page has laid out its words: it is put in place and shown.
function showAlert(height) {
  if (!alertNow || !alertWin || alertWin.isDestroyed() || !Number.isFinite(height)) return;
  const tall = Math.max(40, Math.min(Math.round(height), 400));
  const { x, y, tail } = alertPlace(tall);
  alertWin.setBounds({ x, y, width: ALERT_WIDTH, height: tall });
  alertWin.webContents.send('place', { tail });
  alertWin.showInactive();
}

// The alert is gone from its page, pressed or not.
function endAlert(clicked) {
  const alert = alertNow;
  if (!alert) return;
  if (alertWin && !alertWin.isDestroyed()) alertWin.hide();
  if (clicked && alert.click) alert.click();
  nextAlert();
}

function showWindow() {
  if (alive()) win.show();
}

// Shows the window with the chats of the account in use open.
function pickSession() {
  if (!alive()) return;
  win.show();
  win.webContents.send('pick-session');
}

// Which account was active at a given moment, according to the switch log.
function ownerAt(time) {
  const log = config.switchLog;
  let owner = log.length ? log[0].from || log[0].key : config.activeKey;
  for (const entry of log) {
    if (entry.t > time) break;
    owner = entry.key;
  }
  return owner;
}

// Changes the active account and remembers when it happened.
function switchTo(key, auto) {
  if (config.activeKey !== key) {
    config.switchLog = [...config.switchLog, { t: Date.now(), key, from: config.activeKey, auto }].slice(-200);
  }
  config.activeKey = key;
  config.viewKey = key;
}

// Claude's own apps each leave a trace of the organization they are on:
// - Claude Code (CLI) keeps the signed-in account in ~/.claude.json.
// - The desktop app logs a usage sample, tagged with the organization, whenever it
//   checks usage - which it does right after you switch accounts in it.
// Neither says "this is the one in use", so the organization from whichever trace
// changed last wins. Returns the tracked account's key, or null if nothing is known.
function detectInUse() {
  const seen = config.inUse;
  let cli = null;
  try {
    cli = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')).oauthAccount.organizationUuid || null;
  } catch {}
  let desktop = null;
  try {
    const samples = JSON.parse(fs.readFileSync(desktopUsageLog(), 'utf8')).samples;
    desktop = samples[samples.length - 1];
  } catch {}

  if (desktop && desktop.org && desktop.t !== seen.desktopT) seen.uuid = desktop.org;
  else if (cli && cli !== seen.cli) seen.uuid = cli;
  if (desktop && desktop.t) seen.desktopT = desktop.t;
  seen.cli = cli;

  for (const profile of config.profiles) {
    if (profile.orgs.some((o) => o.uuid === seen.uuid && o.enabled && !o.removed)) return `${profile.id}:${seen.uuid}`;
  }
  return null;
}

function desktopUsageLog() {
  return path.join(app.getPath('appData'), 'Claude', 'plan-usage-history.json');
}

// Makes the account in use the active one. Returns true if that changed anything.
function followInUse() {
  if (!config.settings.autoSwitch) return false;
  const key = detectInUse();
  if (!key || key === config.activeKey) return false;
  switchTo(key, true);
  saveConfig();
  return true;
}

// An account's session and weekly limits as the bars of an alert, named like its two
// chips; `also` is the limit the alert is about, added when it is another one.
function limitMeters(metrics, also) {
  const row = (id, tag) => {
    const m = metrics.find((x) => x.id === id);
    return m ? [{ tag, pct: m.pct }] : [];
  };
  const rows = [...row('five_hour', '5h'), ...row('seven_day', '7d')];
  if (also && !['five_hour', 'seven_day'].includes(also.id)) rows.push({ tag: t(`metric.${also.id}`), pct: also.pct });
  return rows;
}

function recordSample(key, profile, org, metrics) {
  const total = metrics.reduce((sum, m) => sum + m.pct, 0);
  const prev = prevTotals.get(key);
  prevTotals.set(key, total);
  // Usage going up between two samples means this account is the one being used.
  if (prev !== undefined && total > prev) {
    config.lastActivity[key] = Date.now();
    // Only a fallback: when Claude Code says which account it is signed in to, that wins.
    if (config.settings.autoSwitch && !detectInUse()) switchTo(key, true);
    saveConfig();
  }
  if (!config.settings.alerts) return;
  for (const m of metrics) {
    const level = m.pct >= config.settings.critAt ? 2 : m.pct >= config.settings.warnAt ? 1 : 0;
    const id = `${key}:${m.id}`;
    const before = alertLevels.get(id);
    alertLevels.set(id, level);
    // Running out on the active account is announced by the handoff alert instead.
    const handoffCase = level === 2 && key === config.activeKey && m.id !== 'extra_usage';
    // A limit that was nearly exhausted has reset: the account is usable again.
    if (before === 2 && level === 0 && m.id !== 'extra_usage') {
      createNotification({
        kind: 'reset',
        level: 'low',
        meters: limitMeters(metrics, m),
        title: t('notifResetTitle', { label: org.alias || profile.label }),
        body: t('notifResetBody', { metric: t(`metric.${m.id}`), pct: m.pct }),
      }).show();
    }
    if (before !== undefined && level > before && !handoffCase) {
      createNotification({
        kind: 'gauge',
        level: level === 2 ? 'crit' : 'warn',
        meters: limitMeters(metrics, m),
        title: t('notifTitle', { label: org.alias || profile.label, metric: t(`metric.${m.id}`), pct: m.pct }),
        body: t('notifBody', { org: org.name, threshold: level === 2 ? config.settings.critAt : config.settings.warnAt }),
      }).show();
    }
  }
}

// Never throws and always lets go of `refreshing`: a refresh that failed halfway must not
// be the last one. Each part that can fail on its own is kept from stopping the rest.
async function refreshAll() {
  if (refreshing || quitting) return;
  refreshing = true;
  try {
    followInUse();
    pushState();
    await Promise.all(
      config.profiles.map((p) =>
        refreshProfile(p).catch((err) => {
          profileStatus.set(p.id, 'error');
          console.error(`[${p.label}]`, err.message);
        })
      )
    );
  } catch (err) {
    console.error('[refresh]', err.message);
  } finally {
    refreshing = false;
  }
  if (quitting) return;
  try {
    history.save();
    stats = tokenStats(ownerAt, chatNamer());
    sessionList();
  } catch (err) {
    console.error('[insights]', err.message);
  }
  try {
    const state = pushState();
    notifyHandoff(state);
    notifyProjection(state);
    notifyContext();
  } catch (err) {
    console.error('[notify]', err.message);
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (quitting) return;
  // Never faster than every 15 s, whatever the settings file says.
  const seconds = Math.max(15, Number(config.settings.refreshSec) || DEFAULT_SETTINGS.refreshSec);
  pollTimer = setTimeout(async () => {
    await refreshAll();
    schedulePoll();
  }, seconds * 1000);
}

// React within seconds when the user changes account in Claude Code or the desktop app.
// Set up once: each call to watchFile adds a listener of its own.
const watched = () => [CLAUDE_JSON, desktopUsageLog()];
function watchInUse() {
  for (const file of watched()) {
    fs.watchFile(file, { interval: 3000 }, () => {
      try {
        if (followInUse()) pushState();
      } catch (err) {
        console.error('[in use]', err.message);
      }
    });
  }
}

// ---------- state ----------

function colorOf(profile) {
  return COLORS[config.profiles.indexOf(profile) % COLORS.length];
}

function buildAccounts() {
  const accounts = [];
  // One color per card, so several organizations under the same sign-in stay distinguishable.
  let colorIndex = 0;
  const nextColor = () => COLORS[colorIndex++ % COLORS.length];
  for (const profile of config.profiles) {
    const status = profileStatus.get(profile.id) || 'loading';
    const enabled = profile.orgs.filter((o) => o.enabled && !o.removed);
    if (status !== 'ok' || !enabled.length) {
      accounts.push({ key: profile.id, profileId: profile.id, label: profile.label, color: nextColor(), orgName: '', status, metrics: [] });
      continue;
    }
    for (const org of enabled) {
      const key = `${profile.id}:${org.uuid}`;
      const data = usage.get(key);
      // Always advance, so picking a custom color for one card does not reshuffle the others.
      const autoColor = nextColor();
      accounts.push({
        key,
        profileId: profile.id,
        label: org.alias || profile.label,
        color: org.color || autoColor,
        orgName: org.name,
        status: !data ? 'loading' : data.error && !data.metrics.length ? 'error' : 'ok',
        error: data ? data.error : null,
        metrics: data ? data.metrics.map((m) => ({ ...m, fullAt: projection(key, m), pace: pace(key, m) })) : [],
        extra: data ? data.extra : null,
        spark: sparkline(key, data),
        sessionCount: sessionRows.filter((row) => ownsSession(key, row)).length,
        stats: stats.byAccount[key] || { total: 0, projects: [], models: [] },
        switches: config.switchLog.filter((s) => s.key === key).slice(-5).map((s) => ({ t: s.t, auto: s.auto })),
        fetchedAt: data ? data.fetchedAt : null,
        lastActivityAt: config.lastActivity[key] || null,
      });
    }
  }
  return accounts;
}

function projection(key, metric) {
  if (metric.id === 'extra_usage') return null;
  const { window, minSpan } = PROJECTION[metric.id] || PROJECTION.default;
  return projectFull(history.series(key, metric.id, Date.now() - window), metric.resetsAt, minSpan);
}

const HOUR = 60 * MIN;
const WEEK = 7 * 24 * HOUR;

// Where a limit is heading by the time it resets, for the two main ones. The session goes
// by the pace of the last minutes, since it is short: `endPct` is where it would end, and
// the rest goes unused. The week goes by its average pace since it began, which already
// counts nights and days off: `endPct` again, `perDay` is the room left per day, and
// `fullAt` is when it would fill up if that comes before the reset.
function pace(key, metric) {
  const resets = metric.resetsAt ? new Date(metric.resetsAt).getTime() : 0;
  const left = resets - Date.now();
  if (!(left > 0)) return null;
  if (metric.id === 'five_hour') {
    const { window, minSpan } = PROJECTION.five_hour;
    const rate = recentRate(history.series(key, metric.id, Date.now() - window), minSpan);
    return { endPct: Math.min(100, Math.round(metric.pct + rate * left)) };
  }
  if (metric.id !== 'seven_day') return null;
  const elapsed = WEEK - left;
  // Too early in the week for an average to mean anything.
  if (elapsed < 12 * HOUR) return null;
  const endPct = Math.round((metric.pct * WEEK) / elapsed);
  return {
    endPct,
    perDay: Math.max(0, Math.round((100 - metric.pct) / (left / (24 * HOUR)))),
    fullAt: endPct >= 100 && metric.pct > 0 && metric.pct < 100 ? Math.round(resets - WEEK + (100 / metric.pct) * elapsed) : null,
  };
}

// Last 12 h of the account's main limit, as [time, pct] points.
function sparkline(key, data) {
  if (!data || !data.metrics.length) return [];
  return downsample(history.series(key, data.metrics[0].id, Date.now() - 12 * 60 * MIN), 90);
}

// Warns once when a Claude Code session in use has grown past the chosen context size, and
// prepares its handoff prompt so the work can continue in a fresh chat.
function notifyContext() {
  const limit = config.settings.contextWarn;
  for (const s of stats.contexts) {
    if (!limit || s.context < limit) {
      contextNotified.delete(s.id);
      continue;
    }
    if (contextNotified.has(s.id) || !config.settings.alerts || Date.now() - s.usedAt > 15 * MIN) continue;
    contextNotified.add(s.id);
    generatePrompts([s.id]);
    const notification = createNotification({
      kind: 'bill',
      level: 'warn',
      meters: [{ pct: Math.min(100, (s.context / (limit * 2)) * 100), mark: 50, level: 'crit', text: `${Math.round(s.context / 1000)}K / ${limit / 1000}K` }],
      title: t('notifCtxTitle', { name: s.name, n: `${Math.round(s.context / 1000)}K` }),
      body: t('notifCtxBody'),
    });
    notification.on('click', pickSession);
    notification.show();
  }
}

// Warns once per session window when the active account is about to run out at its current pace.
function notifyProjection(state) {
  if (!config.settings.alerts) return;
  const active = state.accounts.find((a) => a.key === state.activeKey);
  const metric = active && active.metrics.find((m) => m.id === 'five_hour');
  if (!metric || !metric.fullAt) return;
  const minutes = Math.round((metric.fullAt - Date.now()) / MIN);
  const id = `${active.key}:${metric.resetsAt}`;
  if (minutes > 15 || minutes < 0 || projectionNotified.has(id)) return;
  projectionNotified.add(id);
  const notification = createNotification({
    kind: 'hourglass',
    level: 'warn',
    meters: limitMeters(active.metrics),
    title: t('notifPaceTitle', { label: active.label, n: Math.max(minutes, 1) }),
    body: t('notifPaceBody', { pct: metric.pct }),
  });
  notification.on('click', showWindow);
  notification.show();
}

// Share of the tightest limit already used; extra usage is paid overflow, not a limit.
function usedPct(account) {
  return Math.max(0, ...account.metrics.filter((m) => m.id !== 'extra_usage').map((m) => m.pct));
}

// When the active account is nearly out, point at the account with the most room left.
function findHandoff(accounts, activeKey) {
  const usable = accounts.filter((a) => a.status === 'ok' && a.metrics.length);
  const from = usable.find((a) => a.key === activeKey);
  if (!from || usedPct(from) < config.settings.critAt) return null;
  const metric = from.metrics.find((m) => m.id !== 'extra_usage' && m.pct === usedPct(from));
  const to = usable
    .filter((a) => a.key !== activeKey && usedPct(a) < config.settings.warnAt)
    .sort((a, b) => usedPct(a) - usedPct(b))[0];
  return {
    fromKey: from.key,
    fromLabel: from.label,
    metricId: metric.id,
    pct: metric.pct,
    toKey: to ? to.key : null,
    toLabel: to ? to.label : null,
    toPct: to ? usedPct(to) : null,
  };
}

function notifyHandoff(state) {
  const handoff = state.handoff;
  if (!handoff) {
    handoffNotified = null;
    return;
  }
  if (handoffNotified === handoff.fromKey || !config.settings.alerts) return;
  handoffNotified = handoff.fromKey;
  const notification = createNotification({
    kind: 'swap',
    level: 'crit',
    // The account that ran out and, when there is one, the one with room.
    meters: [{ tag: handoff.fromLabel, pct: handoff.pct }, ...(handoff.toKey ? [{ tag: handoff.toLabel, pct: handoff.toPct }] : [])],
    title: t('handoffTitle', { label: handoff.fromLabel, metric: t(`metric.${handoff.metricId}`), pct: handoff.pct }),
    body: handoff.toKey ? t('handoffAlt', { label: handoff.toLabel, pct: handoff.toPct }) : t('handoffNone'),
  });
  notification.on('click', showWindow);
  notification.show();
  if (alive()) win.showInactive();
}

// ---------- new versions and feedback ----------

// Tandem is published on GitHub, as releases. Twice a day it asks there for the number of
// the latest one, and that is all it asks or sends. A newer one is told in the app and
// in a notification; downloading and installing it is left to the user.
const REPO = 'abrahamaguero/tandem-claude-usage';
// The only pages the app opens in the browser.
const LINKS = {
  update: `https://github.com/${REPO}/releases/latest`,
  feedback: `https://github.com/${REPO}/issues/new/choose`,
};
const UPDATE_EVERY = 12 * 3600 * 1000;
// `latest` is the version there is to download when it is newer than this one; `checked`,
// whether the last time GitHub was asked it answered.
const update = { latest: null, checked: false };

// Whether version `a` comes after version `b`, both written like "1.2.3".
function isNewer(a, b) {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

async function checkUpdate() {
  if (!config.settings.checkUpdates) return;
  let latest = null;
  let checked = false;
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20000),
    });
    const found = res.ok && /^v?(\d+\.\d+\.\d+)$/.exec(String((await res.json()).tag_name));
    if (found) {
      checked = true;
      if (isNewer(found[1], app.getVersion())) latest = found[1];
    }
  } catch {
    // Offline, or GitHub not answering: the next time will tell.
  }
  // Turned off while the answer was on its way, or nothing to add to what was known.
  if (!config.settings.checkUpdates || (!checked && update.checked)) return;
  const changed = latest !== update.latest || checked !== update.checked;
  Object.assign(update, { latest, checked });
  if (changed) pushState();
  // Said once for each version, not at every start until it is installed.
  if (latest && config.updateTold !== latest) {
    config.updateTold = latest;
    saveConfig();
    const notification = createNotification({ kind: 'download', title: t('updateTitle', { version: latest }), body: t('updateBody') });
    notification.on('click', () => openLink('update'));
    notification.show();
  }
}

function openLink(name) {
  if (Object.hasOwn(LINKS, name)) shell.openExternal(LINKS[name]);
}

// ---------- saved handoff prompts ----------

// Generated prompts are kept on disk so they can be copied later, after switching accounts.
const PROMPT_TTL = 7 * 24 * 3600 * 1000;
let prompts = null; // session id -> { prompt, project, title, createdAt }

function promptsPath() {
  return path.join(app.getPath('userData'), 'prompts.json');
}

// Read from disk once; the old ones are dropped every time, since the app runs for weeks.
function loadPrompts() {
  if (!prompts) {
    const saved = readJson(promptsPath());
    prompts = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  }
  for (const [id, saved] of Object.entries(prompts)) {
    if (!saved || !(Date.now() - saved.createdAt <= PROMPT_TTL)) delete prompts[id];
  }
  return prompts;
}

// Accounts a chat belongs to, limited to the ones still tracked. Null means unknown,
// and the chat is then listed under every account rather than hidden.
function knownOwners(owners) {
  const tracked = new Set(config.profiles.flatMap((p) => p.orgs.filter((o) => o.enabled && !o.removed).map((o) => `${p.id}:${o.uuid}`)));
  const known = (owners || []).filter((key) => tracked.has(key));
  return known.length ? known : null;
}

function ownsSession(key, row) {
  return !row.owners || row.owners.includes(key);
}

// What the Claude desktop app calls each chat, by transcript name.
function appNames() {
  return appSessions(path.join(app.getPath('appData'), 'Claude', 'claude-code-sessions'), 15000);
}

const transcriptName = (id) => path.basename(String(id), '.jsonl');

// The one name a chat goes by in the statistics and alerts, the same one its row shows:
// its title in the Claude app, else the one in its transcript, else its project's folder.
function chatNamer() {
  const names = appNames();
  return (id, chat) => {
    const known = names.get(transcriptName(id));
    return (known && known.title) || chat.title || chat.project;
  };
}

// The active sessions: the chats used in the last 24 h, and no others. An older chat is
// left out even if it has a saved prompt; the prompt is kept, and shows again with the chat
// if it is used again. Each one is filed under the account(s) in use while it was active.
function sessionList() {
  const saved = loadPrompts();
  const recent = listSessions(24);
  const owners = new Map(stats.contexts.map((c) => [c.id, c.owners]));
  const names = appNames();
  // The app's current title and folder for a chat win over what its transcript says: the
  // transcript keeps the first title, and its folder changes as the chat moves around.
  // A chat is shown under one name: its title, or its project's folder when nobody named
  // it, with the start of its first message (`about`) to tell such chats apart.
  const named = (id, fallback) => {
    const known = names.get(transcriptName(id));
    const root = (known && known.folder) || fallback.root || null;
    const project = root ? path.basename(root) : fallback.project;
    const title = (known && known.title) || fallback.title;
    const titled = Boolean(known && known.title) || fallback.titled !== false || !project;
    return { project, title, root, name: titled ? title : project, about: titled ? null : title };
  };
  // Chats of the same project share one graphify state.
  const graphs = new Map();
  const graphOf = (root) => {
    if (!graphs.has(root)) graphs.set(root, graphify.status(root));
    return graphs.get(root);
  };
  // How the chat runs: model and effort as set in the Claude app (else the model of its
  // latest reply), and what it loads from connectors, with the biggest ones by name.
  const setupOf = (s) => {
    const known = names.get(transcriptName(s.id));
    const app = known ? chatSetup(known.file) : null;
    const model = (app && app.model) || s.model;
    return {
      model: model ? modelName(model) : null,
      effort: app ? app.effort : null,
      ultracode: Boolean(app && app.ultracode),
      tools: app ? app.tools : 0,
      connectors: app ? app.connectors.length : 0,
      biggest: app ? app.connectors.slice(0, 8) : [],
    };
  };
  const rows = recent.map((s) => {
    const name = named(s.id, s);
    return {
      ...s,
      ...name,
      setup: setupOf(s),
      recent: true,
      context: contextOf(s.id) || s.context,
      owners: knownOwners(owners.get(s.id)),
      createdAt: saved[s.id] ? saved[s.id].createdAt : null,
      graphify: graphOf(name.root),
    };
  });
  // The chat used last comes first, whether or not it has a prompt.
  rows.sort((a, b) => b.usedAt - a.usedAt);
  sessionRows = rows;
  return rows;
}

function generatePrompts(ids) {
  loadPrompts();
  const names = appNames();
  for (const id of Array.isArray(ids) ? ids : []) {
    const known = names.get(transcriptName(id));
    const handoff = buildHandoff(config.settings.language, String(id), known && known.title);
    if (handoff) prompts[id] = { ...handoff, createdAt: Date.now() };
  }
  try {
    writeJson(promptsPath(), prompts);
  } catch (err) {
    console.error('[prompts]', err.message);
  }
  return sessionList();
}

function copyPrompts(ids) {
  const saved = loadPrompts();
  const texts = (Array.isArray(ids) ? ids : []).filter((id) => Object.hasOwn(saved, id)).map((id) => saved[id].prompt);
  if (texts.length) clipboard.writeText(texts.join('\n\n----------\n\n'));
  return texts.length;
}

// The folder comes from the chat's own transcript, never from the renderer.
async function setupGraphify(id) {
  const row = sessionRows.find((s) => s.id === id);
  const result = await graphify.setup(row && row.root);
  return { ...result, sessions: sessionList() };
}

async function turnOffGraphify(id) {
  const row = sessionRows.find((s) => s.id === id);
  const result = await graphify.turnOff(row && row.root);
  return { ...result, sessions: sessionList() };
}

function buildState() {
  const accounts = buildAccounts();
  const usable = accounts.filter((a) => a.status === 'ok');
  if (!usable.some((a) => a.key === config.activeKey)) {
    const byActivity = [...usable].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    config.activeKey = byActivity.length ? byActivity[0].key : null;
  }
  if (!usable.some((a) => a.key === config.viewKey)) config.viewKey = config.activeKey;
  return {
    settings: config.settings,
    activeKey: config.activeKey,
    viewKey: config.viewKey,
    handoff: findHandoff(accounts, config.activeKey),
    stats,
    refreshing,
    accounts,
    profiles: config.profiles.map((p) => ({
      id: p.id,
      label: p.label,
      color: colorOf(p),
      status: profileStatus.get(p.id) || 'loading',
      orgs: p.orgs.filter((o) => !o.removed),
    })),
    version: app.getVersion(),
    glassOk: GLASS_OK,
    update: { ...update },
  };
}

function pushState() {
  const state = buildState();
  if (alive()) win.webContents.send('state', state);
  updateTray(state);
  return state;
}

// ---------- windows ----------

function createWindow() {
  const saved = config.bounds;
  // The window keeps its right edge when its width changes between versions: saved bounds
  // carry the width they were taken at (360 before it was stored).
  const right = saved ? saved.x + (saved.w || 360) : null;
  const area = saved ? screen.getDisplayNearestPoint({ x: right, y: saved.y }).workArea : screen.getPrimaryDisplay().workArea;
  const left = saved ? Math.max(area.x, Math.min(right, area.x + area.width) - WIDTH) : area.x + area.width - WIDTH - 16;
  // The window itself never changes size: it is see-through and as tall as the screen
  // allows, and the panel grows and shrinks inside it, standing on its bottom edge. Moving
  // a real window pixel by pixel stutters; a panel sliding inside a still one does not.
  const tall = area.height - 16;
  // Saved bounds store the bottom edge, which is where the panel stands. It is kept on
  // the screen: the one it was saved on may be gone, or be smaller now.
  const bottom = Math.max(area.y + 200, Math.min(saved ? saved.y : area.y + area.height - 16, area.y + area.height));
  win = new BrowserWindow({
    width: WIDTH,
    height: tall,
    x: left,
    y: bottom - tall,
    frame: false,
    transparent: true,
    thickFrame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    icon: path.join(__dirname, 'icon.png'),
    alwaysOnTop: config.settings.alwaysOnTop,
    skipTaskbar: config.settings.hideFromTaskbar,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  setPanel(1);
  // The window shows its own page and nothing else: a link or a file dropped on it must
  // not replace it, since whatever loaded there would get the app's own bridge.
  const page = win.webContents;
  page.on('will-navigate', (e, url) => { if (url !== page.getURL()) e.preventDefault(); });
  page.setWindowOpenHandler(() => ({ action: 'deny' }));
  page.on('render-process-gone', () => alive() && !quitting && page.reload());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // Windows can put the window back on the taskbar when it is shown again. The tray menu
  // says "show" or "hide" after what the window is doing.
  win.on('show', () => {
    win.setSkipTaskbar(config.settings.hideFromTaskbar);
    updateTray(buildState());
    // The page brings the panel in, and tells the glass when to come in behind it.
    page.send('enter');
  });
  win.on('hide', () => {
    if (glass && !glass.isDestroyed()) glass.hide();
    updateTray(buildState());
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hidePanel();
  });
  // The glass is a window of its own and goes wherever the panel goes.
  win.on('move', () => placeGlass(panelHeight));
  win.on('moved', () => {
    refit();
    const b = win.getBounds();
    config.bounds = { x: b.x, y: b.y + b.height, w: b.width };
    saveConfig();
  });
}

// The window is as tall as its screen allows and stands inside it. That is seen to again
// when it is moved to another screen or the screens change, and so is its shape, which
// Windows keeps in the pixels of the screen it was given on.
function refit() {
  if (!alive()) return;
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const tall = area.height - 16;
  const bottom = Math.max(area.y + 200, Math.min(b.y + b.height, area.y + area.height));
  const x = Math.max(area.x, Math.min(b.x, area.x + area.width - WIDTH));
  if (b.x !== x || b.y !== bottom - tall || b.height !== tall) win.setBounds({ x, y: bottom - tall, width: WIDTH, height: tall });
  setPanel(panelHeight);
  placeGlass(panelHeight);
}

// How much of the window, from its bottom edge up, the panel covers. Only that part is
// the window as far as the mouse goes: the rest is see-through and lets clicks through to
// whatever is behind it.
function setPanel(height) {
  if (!alive() || !Number.isFinite(height)) return;
  panelHeight = height;
  const b = win.getBounds();
  const h = Math.max(1, Math.min(Math.round(height), b.height));
  win.setShape([{ x: 0, y: b.height - h, width: b.width, height: h }]);
}

// ---------- glass ----------

// The glass effect is Windows' own blurred "acrylic", and Windows draws it over the whole
// of a window: it cannot go on the panel's window, which is as tall as the screen. It
// goes on a second, empty window kept right behind the panel and a little smaller than it
// (GLASS_RIM), so that its square corners stay under the panel's round ones. While the
// glass is on, the panel's window is its child: that keeps the two together, in front of
// other windows or behind them.
const GLASS_RIM = 7;
// Windows only draws that glass from Windows 11 22H2 on. On anything older the option is
// not offered: the panel would turn see-through with nothing blurred behind it.
const GLASS_OK = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621;
let glass = null;
let panelHeight = 1; // how tall the panel is, as the page last said

function setGlass(on) {
  if (!alive()) return;
  on = Boolean(on) && GLASS_OK;
  if (on && !glass) {
    glass = new BrowserWindow({
      width: 40,
      height: 40,
      frame: false,
      transparent: true,
      thickFrame: false,
      backgroundMaterial: 'acrylic',
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: config.settings.alwaysOnTop,
    });
    glass.setIgnoreMouseEvents(true);
    // Closing it would close the panel with it, being its parent: only quitting may.
    glass.on('close', (e) => { if (!quitting) e.preventDefault(); });
    glass.on('closed', () => { glass = null; });
    win.setParentWindow(glass);
    placeGlass(panelHeight);
  } else if (!on && glass) {
    // The child is let go first: a window is destroyed along with its parent.
    const old = glass;
    glass = null;
    win.setParentWindow(null);
    if (!old.isDestroyed()) old.destroy();
  }
  // Windows tints its glass dark or light after the app, so it follows the theme.
  nativeTheme.themeSource = on ? (config.settings.theme === 'porcelain' ? 'light' : 'dark') : 'system';
}

// Puts the glass behind the panel, which stands `height` tall on the bottom of its window.
function placeGlass(height) {
  if (!Number.isFinite(height)) return;
  panelHeight = height;
  if (!glass || glass.isDestroyed() || !alive()) return;
  const b = win.getBounds();
  const tall = Math.min(Math.round(height), b.height);
  if (!win.isVisible() || tall < 4 * GLASS_RIM) return glass.hide();
  glass.setBounds({ x: b.x + GLASS_RIM, y: b.y + b.height - tall + GLASS_RIM, width: b.width - 2 * GLASS_RIM, height: tall - 2 * GLASS_RIM });
  if (!glass.isVisible()) glass.showInactive();
}

// Hides the window once the page has emptied the panel. What Windows shows first of a
// window that comes back is the last thing it showed of it: left as it was, the panel
// would flash whole for a moment before coming in.
let leaving = false;
function hidePanel() {
  if (!alive() || !win.isVisible() || leaving) return;
  leaving = true;
  const done = () => {
    if (!leaving) return;
    leaving = false;
    clearTimeout(timer);
    ipcMain.removeListener('left', done);
    if (alive()) win.hide();
  };
  // A page that does not answer must not keep the window from hiding.
  const timer = setTimeout(done, 200);
  ipcMain.once('left', done);
  // The glass goes first: alone on screen, it is a blurred box.
  if (glass && !glass.isDestroyed()) glass.hide();
  win.webContents.send('leave');
}

function toggleWindow() {
  if (!alive()) return;
  if (win.isVisible()) hidePanel();
  else win.show();
}

// The sign-in to claude.ai for one account, in a window of its own: the account's session
// is what Tandem reads the usage with, and a browser does not hand its sessions to other
// programs. On top of the page goes a line of Tandem's own (login-note.html) saying how to
// get through quickly; that is why the window is made of two parts.
function openLogin(profile) {
  const existing = loginWindows.get(profile.id);
  if (existing && !existing.isDestroyed()) return existing.focus();
  lockDown(session.fromPartition(profile.partition));
  const title = t('signInTitle', { label: profile.label });
  const loginWin = new BaseWindow({
    width: 520,
    height: 840,
    title,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
  });
  const note = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  const view = new WebContentsView({ webPreferences: { partition: profile.partition, sandbox: true, contextIsolation: true } });
  loginWin.contentView.addChildView(note);
  loginWin.contentView.addChildView(view);
  const page = view.webContents;
  loginWindows.set(profile.id, loginWin);

  // The line is as tall as its words, which depends on the language; the page has the rest.
  let noteHeight = 72;
  const layout = () => {
    if (loginWin.isDestroyed()) return;
    const { width, height } = loginWin.getContentBounds();
    note.setBounds({ x: 0, y: 0, width, height: noteHeight });
    view.setBounds({ x: 0, y: noteHeight, width, height: Math.max(0, height - noteHeight) });
  };
  layout();
  loginWin.on('resize', layout);
  note.webContents.on('will-navigate', (e) => e.preventDefault());
  note.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  note.webContents.on('did-finish-load', async () => {
    try {
      const tall = await note.webContents.executeJavaScript("document.querySelector('.login-note').offsetHeight");
      if (Number.isFinite(tall) && tall > 0) {
        noteHeight = Math.min(160, Math.ceil(tall));
        layout();
      }
    } catch {}
  });
  note.webContents.loadFile(path.join(__dirname, 'renderer', 'login-note.html'), {
    query: { title: t('loginNoteTitle'), text: t('loginNoteText'), theme: config.settings.theme, lang: config.settings.language },
  });

  // The window has no address bar, so its title says which site is asking for the
  // password: signing in with Google or another provider takes it away from claude.ai.
  const showSite = () => {
    if (loginWin.isDestroyed()) return;
    let site = '';
    try {
      site = new URL(page.getURL()).host;
    } catch {}
    loginWin.setTitle(site ? `${title} · ${site}` : title);
  };
  page.on('page-title-updated', showSite);
  page.on('did-navigate', showSite);
  // Ready to type in.
  page.once('did-finish-load', () => { if (!loginWin.isDestroyed()) page.focus(); });
  // Windows the sign-in opens (a provider's own pop-up) are closed along with it.
  const popups = new Set();
  page.on('did-create-window', (popup) => {
    popups.add(popup);
    popup.on('closed', () => popups.delete(popup));
  });
  page.loadURL(`${BASE}/login`);
  let checking = false;
  const timer = setInterval(async () => {
    if (loginWin.isDestroyed()) return clearInterval(timer);
    if (checking || !(await hasSession(profile))) return;
    checking = true;
    try {
      if ((await loadOrgs(profile)) === 'ok') {
        clearInterval(timer);
        profileStatus.set(profile.id, 'ok');
        if (!loginWin.isDestroyed()) loginWin.close();
        refreshAll();
      }
    } catch {}
    checking = false;
  }, 2500);
  loginWin.on('closed', () => {
    clearInterval(timer);
    loginWindows.delete(profile.id);
    for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
    // The two parts are not let go of along with their window.
    for (const part of [note, view]) if (!part.webContents.isDestroyed()) part.webContents.close();
  });
}

// ---------- tray ----------

function updateTray(state) {
  if (!trays.size || quitting) return;
  for (const [key, tray] of trays) tray.setToolTip((trayTips.get(key) || 'Tandem - Claude Usage').slice(0, 127));
  const menu = Menu.buildFromTemplate([
    { label: alive() && win.isVisible() ? t('hideWidget') : t('showWidget'), click: toggleWindow },
    { type: 'separator' },
    ...state.accounts
      .filter((a) => a.status === 'ok')
      .map((a) => ({
        label: `${a.label}${a.orgName ? ` — ${a.orgName}` : ''}`,
        type: 'radio',
        checked: a.key === state.activeKey,
        // With auto-switch on, the account in use is detected, not chosen.
        enabled: !state.settings.autoSwitch,
        click: () => setActive(a.key),
      })),
    { type: 'separator' },
    {
      label: t('autoSwitch'),
      type: 'checkbox',
      checked: state.settings.autoSwitch,
      click: (item) => setSetting('autoSwitch', item.checked),
    },
    { label: t('refreshNow'), click: refreshAll },
    { label: t('handoffCopy'), click: pickSession },
    { type: 'separator' },
    { label: t('quit'), click: () => app.quit() },
  ]);
  for (const tray of trays.values()) tray.setContextMenu(menu);
}

// ---------- actions ----------

// Clicking a card. With auto-switch on it only chooses which card is opened up;
// the account in use keeps being detected. With it off, the click picks the account.
function setActive(key) {
  // Only an account the app is tracking: the key ends up in the settings file.
  const known = config.profiles.some((p) => p.id === key || p.orgs.some((o) => `${p.id}:${o.uuid}` === key));
  if (!known) return;
  if (config.settings.autoSwitch) config.viewKey = key;
  else switchTo(key, false);
  saveConfig();
  pushState();
}

// Only a setting that exists, and with a value of its kind.
function setSetting(name, value) {
  if (!Object.hasOwn(DEFAULT_SETTINGS, name) || typeof value !== typeof DEFAULT_SETTINGS[name]) return;
  if (typeof value === 'number' && !Number.isFinite(value)) return;
  if (name === 'language' && !languages.includes(value)) return;
  config.settings[name] = value;
  saveConfig();
  if (name === 'alwaysOnTop' && alive()) {
    win.setAlwaysOnTop(value);
    if (glass && !glass.isDestroyed()) glass.setAlwaysOnTop(value);
  }
  if (name === 'glass' || (name === 'theme' && config.settings.glass)) setGlass(config.settings.glass);
  if (name === 'hideFromTaskbar' && alive()) win.setSkipTaskbar(value);
  if (name === 'refreshSec') schedulePoll();
  if (name === 'ownAlerts' && !value) {
    alertQueue.length = 0;
    alertNow = null;
    if (alertWin && !alertWin.isDestroyed()) alertWin.hide();
  }
  if (name === 'checkUpdates') {
    Object.assign(update, { latest: null, checked: false });
    if (value) checkUpdate();
  }
  if (name === 'autoSwitch') followInUse();
  if (name === 'launchAtStartup') {
    app.setLoginItemSettings({
      openAtLogin: value,
      path: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()],
    });
  }
  pushState();
}

async function removeProfile(profileId) {
  const profile = config.profiles.find((p) => p.id === profileId);
  if (!profile) return;
  config.profiles = config.profiles.filter((p) => p.id !== profileId);
  const worker = workers.get(profileId);
  if (worker && !worker.win.isDestroyed()) worker.win.destroy();
  workers.delete(profileId);
  // A sign-in left open would bring the account's session back after it was removed.
  const login = loginWindows.get(profileId);
  if (login && !login.isDestroyed()) login.close();
  for (const key of [...usage.keys()]) if (key.startsWith(profileId)) usage.delete(key);
  saveConfig();
  pushState();
  // Its sign-in is wiped last: should that fail, the account is gone from the app anyway.
  try {
    await session.fromPartition(profile.partition).clearStorageData();
  } catch (err) {
    console.error('[remove]', err.message);
  }
}

function registerIpc() {
  ipcMain.on('ready', pushState);
  ipcMain.on('refresh', refreshAll);
  ipcMain.handle('list-sessions', sessionList);
  ipcMain.handle('generate-prompts', (_e, ids) => generatePrompts(ids));
  ipcMain.handle('copy-prompts', (_e, ids) => copyPrompts(ids));
  ipcMain.handle('graphify-setup', (_e, id) => setupGraphify(id));
  ipcMain.handle('graphify-off', (_e, id) => turnOffGraphify(id));
  ipcMain.handle('graphify-copy', () => clipboard.writeText(graphify.FULL_GRAPH_COMMAND));
  ipcMain.on('hide', hidePanel);
  ipcMain.on('set-active', (_e, key) => setActive(key));
  ipcMain.on('set-setting', (_e, name, value) => setSetting(name, value));
  ipcMain.on('glass', (_e, height) => placeGlass(height));
  ipcMain.on('open-link', (_e, name) => openLink(String(name)));
  // What an alert looks like and where it shows, for whoever is deciding in the settings.
  ipcMain.on('test-alert', () => createNotification({ kind: 'bell', title: 'Tandem', body: t('alertTest'), meters: [{ tag: '5h', pct: 38 }, { tag: '7d', pct: 76 }] }).on('click', showWindow).show());
  // Only the alert's own page is listened to about the alert.
  const fromAlert = (e) => Boolean(alertWin) && !alertWin.isDestroyed() && e.sender === alertWin.webContents;
  ipcMain.on('alert-size', (e, height) => { if (fromAlert(e)) showAlert(height); });
  ipcMain.on('alert-done', (e, clicked) => { if (fromAlert(e)) endAlert(clicked === true); });
  ipcMain.on('resize', (_e, height) => setPanel(height));
  ipcMain.on('tray-images', (_e, sent) => {
    // Two icons at most, each a picture the page drew: nothing else becomes a tray icon.
    const images = (Array.isArray(sent) ? sent : []).filter((i) => i && ['session', 'weekly'].includes(i.key) && String(i.dataUrl).startsWith('data:image/png'));
    const wanted = new Set(images.map((i) => i.key));
    for (const [key, tray] of trays) {
      if (wanted.has(key)) continue;
      tray.destroy();
      trays.delete(key);
    }
    // Windows puts each new tray icon to the left of the previous one, so create them
    // last-to-first to end up with the session on the left and the week on the right.
    for (const { key, dataUrl, tip } of [...images].reverse()) {
      trayTips.set(key, String(tip || ''));
      const image = nativeImage.createFromDataURL(dataUrl);
      if (trays.has(key)) {
        trays.get(key).setImage(image);
        continue;
      }
      const tray = new Tray(image);
      tray.on('click', toggleWindow);
      trays.set(key, tray);
    }
    updateTray(buildState());
  });
  ipcMain.on('add-profile', (_e, label) => {
    const id = crypto.randomUUID();
    const profile = {
      id,
      label: String(label || '').trim().slice(0, 30) || t('accountN', { n: config.profiles.length + 1 }),
      partition: `persist:claude-${id}`,
      orgs: [],
    };
    config.profiles.push(profile);
    profileStatus.set(id, 'login');
    saveConfig();
    pushState();
    openLogin(profile);
  });
  ipcMain.on('login', (_e, profileId) => {
    const profile = config.profiles.find((p) => p.id === profileId);
    if (profile) openLogin(profile);
  });
  ipcMain.on('remove-profile', (_e, profileId) => removeProfile(profileId));
  ipcMain.on('remove-org', (_e, profileId, uuid) => {
    const profile = config.profiles.find((p) => p.id === profileId);
    const org = profile && profile.orgs.find((o) => o.uuid === uuid);
    if (!org) return;
    org.removed = true;
    usage.delete(`${profileId}:${uuid}`);
    // Nothing left to track under this sign-in, so drop the sign-in too.
    if (profile.orgs.every((o) => o.removed)) return removeProfile(profileId);
    saveConfig();
    pushState();
  });
  ipcMain.on('set-org-color', (_e, profileId, uuid, color) => {
    const profile = config.profiles.find((p) => p.id === profileId);
    const org = profile && profile.orgs.find((o) => o.uuid === uuid);
    if (!org || !/^#[0-9a-f]{6}$/i.test(color)) return;
    org.color = color;
    saveConfig();
    pushState();
  });
  ipcMain.on('rename-org', (_e, profileId, uuid, alias) => {
    const profile = config.profiles.find((p) => p.id === profileId);
    const org = profile && profile.orgs.find((o) => o.uuid === uuid);
    if (!org) return;
    org.alias = String(alias || '').trim().slice(0, 30);
    saveConfig();
    pushState();
  });
  ipcMain.on('toggle-org', (_e, profileId, uuid, enabled) => {
    const profile = config.profiles.find((p) => p.id === profileId);
    const org = profile && profile.orgs.find((o) => o.uuid === uuid);
    if (!org) return;
    org.enabled = !!enabled;
    saveConfig();
    refreshAll();
  });
}

// ---------- boot ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  // Sign-in providers reject embedded browsers that announce themselves as Electron.
  app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|tandem)\/\S+/gi, '');
  app.setAppUserModelId('com.klugeinteractive.tandem');
  app.on('window-all-closed', () => {});
  // Closing down: nothing may start again, nor look for a window that is going away.
  app.on('before-quit', () => {
    quitting = true;
    clearTimeout(pollTimer);
    for (const file of watched()) fs.unwatchFile(file);
  });
  app.whenReady().then(async () => {
    // No menu: its shortcuts would reload the page, zoom it or open the developer tools.
    Menu.setApplicationMenu(null);
    lockDown(session.defaultSession);
    loadConfig();
    // Keep the Windows startup entry pointing at this copy of the app.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: config.settings.launchAtStartup, path: process.execPath, args: [] });
    history = createHistory(path.join(app.getPath('userData'), 'history.json'));
    registerIpc();
    createWindow();
    if (config.settings.glass) setGlass(true);
    // The window follows its screen when the screens change.
    for (const change of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(change, refit);
    watchInUse();
    await refreshAll();
    schedulePoll();
    checkUpdate();
    setInterval(checkUpdate, UPDATE_EVERY);
  }).catch((err) => {
    // Without this the app would stay running with no window and no tray icon, and hold
    // on to being the only copy: starting it again would do nothing.
    dialog.showErrorBox('Tandem', String((err && err.stack) || err));
    app.quit();
  });
}
