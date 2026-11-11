// Checks src/limits.js: reading the limits out of claude.ai's answer, in the shape it has
// had since November 2026 and in the older one. The figures are made up.
// Run with: node tools/limits-test.js
const assert = require('assert');
const { extractMetrics, extractBreakdown, weekRunsOut, planOf, orgLabel } = require('../src/limits');

const field = (utilization, resets) => ({ utilization, resets_at: resets, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null });
const limit = (kind, percent, resets, scope = null) => ({ kind, group: kind === 'session' ? 'session' : 'weekly', percent, severity: 'normal', resets_at: resets, scope, is_active: false });
const fable = { model: { id: null, display_name: 'Fable' }, surface: null };

// An account with a session limit: the list and the old fields say the same, once each.
const withSession = {
  five_hour: field(5, 'S'),
  seven_day: field(25, 'W'),
  seven_day_opus: null,
  extra_usage: { is_enabled: true, monthly_limit: 20000, used_credits: 0, utilization: null },
  limits: [limit('session', 5, 'S'), limit('weekly_all', 25, 'W'), limit('weekly_scoped', 0, 'W', fable)],
  weekly_scoped_shares: [{ limit_index: 2, used_percent_of_weekly: 0, allowance_percent_of_weekly: 50 }],
  seven_day_breakdown: null,
};
assert.deepStrictEqual(extractMetrics(withSession), [
  { id: 'five_hour', pct: 5, resetsAt: 'S' },
  { id: 'seven_day', pct: 25, resetsAt: 'W' },
  { id: 'seven_day:Fable', pct: 0, resetsAt: 'W', scope: 'Fable', share: { allowance: 50, used: 0 } },
]);
assert.strictEqual(extractBreakdown(withSession), null);

// A verified Ultra account: no session limit at all, extra usage off (a figure of 0), and
// where its week went.
const ultra = {
  five_hour: null,
  seven_day: field(8, 'W'),
  extra_usage: { is_enabled: false, monthly_limit: 5000, used_credits: 0, utilization: 0 },
  limits: [limit('weekly_all', 8, 'W'), limit('weekly_scoped', 5, 'W2', fable)],
  weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 3, allowance_percent_of_weekly: 50 }],
  seven_day_breakdown: { as_of: 'now', window_started_at: 'then', rows: [
    { key: 'claude_code', display_name: 'Claude Code', percent: 85 },
    { key: 'chat', display_name: 'Chats', percent: 1 },
    { key: 'cowork', display_name: 'Cowork', percent: 14 },
    { key: 'other', display_name: 'Other', percent: 0 },
  ] },
};
const metrics = extractMetrics(ultra);
assert.deepStrictEqual(metrics.map((m) => m.id), ['seven_day', 'seven_day:Fable', 'extra_usage']);
assert.ok(!metrics.some((m) => m.id === 'five_hour'), 'no session limit');
assert.deepStrictEqual(metrics[1].share, { allowance: 50, used: 3 });
assert.deepStrictEqual(extractBreakdown(ultra).rows.map((row) => [row.key, row.pct]), [['claude_code', 85], ['chat', 1], ['cowork', 14], ['other', 0]]);

// The older answer, with a field per limit and no list, still reads as before.
assert.deepStrictEqual(extractMetrics({ seven_day: field(40, 'W'), five_hour: field(12, 'S'), seven_day_opus: field(3, 'O') }).map((m) => [m.id, m.pct]), [['five_hour', 12], ['seven_day', 40], ['seven_day_opus', 3]]);

// Whatever is odd in the answer is left out instead of breaking the rest.
assert.deepStrictEqual(extractMetrics({ limits: [null, 'x', { kind: 'session' }, limit('weekly_all', 9.6, 'W')] }), [{ id: 'seven_day', pct: 10, resetsAt: 'W' }]);
assert.deepStrictEqual(extractMetrics(null), []);
assert.strictEqual(extractBreakdown({ seven_day_breakdown: { rows: [{ key: 'chat', percent: 0 }] } }), null);

// The week that will not last: told only once a day of it has gone by, and only when the
// pace runs it out before it resets.
const H = 3600 * 1000;
const now = Date.parse('2026-11-12T12:00:00Z');
const week = (hoursLeft, fullIn, pct = 60) => ({ id: 'seven_day', pct, resetsAt: new Date(now + hoursLeft * H).toISOString(), pace: { endPct: 120, perDay: 9, fullAt: fullIn == null ? null : now + fullIn * H } });
assert.deepStrictEqual(weekRunsOut(week(96, 30), now), { fullAt: now + 30 * H, resets: now + 96 * H, pct: 60, perDay: 9 });
assert.strictEqual(weekRunsOut(week(150, 30), now), null, 'the week is less than a day old');
assert.strictEqual(weekRunsOut(week(96, null), now), null, 'it lasts');
assert.strictEqual(weekRunsOut(week(96, 100), now), null, 'it would run out after the reset');
assert.strictEqual(weekRunsOut({ ...week(96, 30), id: 'five_hour' }, now), null, 'only the week');
assert.strictEqual(weekRunsOut(undefined, now), null);

// The plan of an organization, by what claude.ai says of it.
assert.strictEqual(planOf({ capabilities: ['claude_max', 'chat'], rate_limit_tier: 'default_claude_max_20x', analytics_subscription_plan: 'claude_max 20x' }), 'ultra');
assert.strictEqual(planOf({ capabilities: ['claude_max', 'chat'], rate_limit_tier: 'default_claude_max_5x' }), 'max');
assert.strictEqual(planOf({ capabilities: ['claude_pro', 'chat'], rate_limit_tier: 'default_claude_ai' }), 'pro');
assert.strictEqual(planOf({ capabilities: ['raven', 'chat'], rate_limit_tier: 'default_raven', raven_type: 'team' }), 'team');
assert.strictEqual(planOf({ capabilities: ['raven', 'chat'], raven_type: 'enterprise' }), 'enterprise');
assert.strictEqual(planOf({ capabilities: ['chat'], rate_limit_tier: 'default_claude_ai' }), 'free');
assert.strictEqual(planOf({ capabilities: ['chat'], plan_display_label: ' Ultra ' }), 'Ultra');
assert.strictEqual(planOf({ capabilities: ['api'], billing_type: 'prepaid' }), null);
assert.strictEqual(planOf(null), null);

// A personal account's organization is shown as the account: its email.
assert.strictEqual(orgLabel("someone@example.com's Organization"), 'someone@example.com');
assert.strictEqual(orgLabel('someone@example.com’s Organization'), 'someone@example.com');
assert.strictEqual(orgLabel('Acme'), 'Acme');
assert.strictEqual(orgLabel(null), '');

console.log('limits.js: all cases passed');
