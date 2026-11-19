const num = (v) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const add = (a, b) => (a === null || b === null ? null : a + b);
const sub = (a, b) => (a === null || b === null ? null : a - b);

export function toMetrics(m) {
  const hg = num(m.homeGoals), ag = num(m.awayGoals);
  const hx = num(m.xg?.home), ax = num(m.xg?.away);
  const hs = num(m.shots?.home), as = num(m.shots?.away);
  const ht = num(m.shotsOnTarget?.home), at = num(m.shotsOnTarget?.away);
  return {
    pre_home: num(m.preOdds?.home), pre_draw: num(m.preOdds?.draw), pre_away: num(m.preOdds?.away), pre_over25: num(m.preOdds?.over25),
    live_home: num(m.liveOdds?.home), live_draw: num(m.liveOdds?.draw), live_away: num(m.liveOdds?.away), live_over25: num(m.liveOdds?.over25),
    home_goals: hg, away_goals: ag, total_goals: add(hg, ag), goal_diff: sub(hg, ag),
    home_shots: hs, away_shots: as, total_shots: add(hs, as),
    home_sot: ht, away_sot: at, total_sot: add(ht, at),
    home_xg: hx, away_xg: ax, total_xg: add(hx, ax),
    minute: num(m.minute),
  };
}

const OPS = {
  ">=": (a, b) => a >= b,
  ">": (a, b) => a > b,
  "<=": (a, b) => a <= b,
  "<": (a, b) => a < b,
  "==": (a, b) => a === b,
};

export function ruleMatches(rule, metrics) {
  if (!rule.enabled || !rule.conditions?.length) return false;
  return rule.conditions.every((c) => {
    const v = metrics[c.metric];
    return v !== null && v !== undefined && !Number.isNaN(v) && OPS[c.op]?.(v, Number(c.value));
  });
}

// Aynı maç + aynı koşul kümesi = aynı bildirim (kural adı önemli değil)
const sig = (r) => JSON.stringify((r.conditions || []).map((c) => [c.metric, c.op, Number(c.value)]).sort());

// fired: { anahtar: zaman }. Anahtarı gönderim başarılı olunca server yazar.
export function findTriggered(rules, match, fired = {}) {
  const metrics = toMetrics(match), seen = new Set(), out = [];
  for (const rule of rules) {
    if (rule.matchId && String(rule.matchId) !== String(match.id)) continue;
    const key = `${match.id}:${sig(rule)}`;
    if (fired[key] || seen.has(key) || !ruleMatches(rule, metrics)) continue;
    seen.add(key);
    out.push({ rule, key });
  }
  return out;
}

export function formatAlert(match, rule) {
  return `🔔 <b>${rule.name}</b>\n${match.minute}' <b>${match.home} ${match.homeGoals} - ${match.awayGoals} ${match.away}</b>`;
}
