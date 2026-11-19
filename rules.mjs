// Kural motoru: paneldeki kuralları canlı maç verisine karşı değerlendirir.

const num = (v) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const add = (a, b) => (a === null || b === null ? null : a + b);
const sub = (a, b) => (a === null || b === null ? null : a - b);

export function toMetrics(m) {
  const hg = num(m.homeGoals), ag = num(m.awayGoals);
  const hx = num(m.xg?.home), ax = num(m.xg?.away);
  return {
    pre_home: num(m.preOdds?.home), pre_draw: num(m.preOdds?.draw), pre_away: num(m.preOdds?.away),
    live_home: num(m.liveOdds?.home), live_draw: num(m.liveOdds?.draw), live_away: num(m.liveOdds?.away),
    home_goals: hg, away_goals: ag,
    total_goals: add(hg, ag),
    goal_diff: sub(hg, ag),
    home_shots: num(m.shots?.home), away_shots: num(m.shots?.away),
    home_sot: num(m.shotsOnTarget?.home), away_sot: num(m.shotsOnTarget?.away),
    home_xg: hx, away_xg: ax,
    total_xg: add(hx, ax),
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

const fired = new Set();
export function findTriggered(rules, match) {
  const metrics = toMetrics(match);
  const out = [];
  for (const rule of rules) {
    if (rule.matchId && String(rule.matchId) !== String(match.id)) continue;
    const key = `${match.id}:${rule.id}`;
    if (!fired.has(key) && ruleMatches(rule, metrics)) {
      fired.add(key);
      out.push(rule);
    }
  }
  return out;
}

export function formatAlert(match, rule) {
  return `🔔 <b>${rule.name}</b>\n${match.minute}' <b>${match.home} ${match.homeGoals} - ${match.awayGoals} ${match.away}</b>`;
}
