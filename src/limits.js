// Reads claude.ai's answer about an account's usage: its limits and where its week went.
// Kept apart from main.js so that it can be tested without Electron (tools/limits-test.js):
// claude.ai changes this answer from time to time.

// The order the limits are shown in.
const METRIC_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_cowork', 'seven_day_oauth_apps', 'extra_usage'];
// What claude.ai's list of limits calls the two main ones, as Tandem has always named them.
// A limit of the week scoped to one model or product (Fable's share of the week, say) is
// "seven_day:<its name>", and carries that name in `scope`.
const LIMIT_IDS = { session: 'five_hour', weekly_all: 'seven_day' };

// The limits of an account, from claude.ai's answer, as { id, pct, resetsAt } and, for one
// scoped to a model or product, its `scope` and `share` (how much of the week it may take,
// and has taken). claude.ai lists them in `limits` now; the fields it had one per limit are
// still read for anything the list leaves out, the extra usage among them. An account with
// no 5-hour limit, as a verified Ultra one, simply has no session limit listed.
function extractMetrics(json) {
  const metrics = [];
  const shares = Array.isArray(json && json.weekly_scoped_shares) ? json.weekly_scoped_shares : [];
  (Array.isArray(json && json.limits) ? json.limits : []).forEach((limit, index) => {
    if (!limit || typeof limit !== 'object' || typeof limit.percent !== 'number') return;
    const where = limit.scope && (limit.scope.model || limit.scope.surface);
    const scope = where && typeof where.display_name === 'string' ? where.display_name.slice(0, 40) : '';
    const id = LIMIT_IDS[limit.kind] || (scope ? `seven_day:${scope}` : String(limit.kind || ''));
    if (!id || metrics.some((m) => m.id === id)) return;
    const metric = { id, pct: Math.round(limit.percent), resetsAt: limit.resets_at || null };
    if (!LIMIT_IDS[limit.kind] && scope) {
      metric.scope = scope;
      const share = shares.find((s) => s && s.limit_index === index);
      if (share && typeof share.allowance_percent_of_weekly === 'number') {
        metric.share = { allowance: Math.round(share.allowance_percent_of_weekly), used: Math.round(Number(share.used_percent_of_weekly) || 0) };
      }
    }
    metrics.push(metric);
  });
  for (const [id, value] of Object.entries(json || {})) {
    if (metrics.some((m) => m.id === id)) continue;
    if (value && typeof value === 'object' && typeof value.utilization === 'number') {
      metrics.push({ id, pct: Math.round(value.utilization), resetsAt: value.resets_at || null });
    }
  }
  // A scoped limit goes right after the week it is part of.
  const rank = (m) => {
    const at = METRIC_ORDER.indexOf(m.id.startsWith('seven_day:') ? 'seven_day' : m.id);
    return at < 0 ? METRIC_ORDER.length : at + (m.id.includes(':') ? 0.5 : 0);
  };
  return metrics.sort((a, b) => rank(a) - rank(b));
}

// Where the week's usage went, by product (Claude Code, chats, Cowork…), when claude.ai
// says: each part's share, in percent of what has been used.
function extractBreakdown(json) {
  const breakdown = json && json.seven_day_breakdown;
  if (!breakdown || !Array.isArray(breakdown.rows)) return null;
  const rows = breakdown.rows
    .filter((row) => row && typeof row.percent === 'number')
    .map((row) => ({ key: String(row.key || ''), name: String(row.display_name || row.key || '').slice(0, 30), pct: Math.max(0, Math.round(row.percent)) }));
  return rows.some((row) => row.pct > 0) ? { rows } : null;
}

module.exports = { extractMetrics, extractBreakdown, METRIC_ORDER, LIMIT_IDS };
