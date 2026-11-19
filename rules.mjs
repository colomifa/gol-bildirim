// Kural motoru: paneldeki kuralları canlı maç verisine karşı değerlendirir.

export function toMetrics(m) {
  const g = (v) => (v === undefined || v === null ? null : Number(v));
  return {
    pre_home: g(m.preOdds?.home), pre_draw: g(m.preOdds?.draw), pre_away: g(m.preOdds?.away),
    live_home: g(m.liveOdds?.home), live_draw: g(m.liveOdds?.draw), live_away: g(m.liveOdds?.away),
    home_goals: g(m.homeGoals), away_goals: g(m.awayGoals),
    total_goals: g(m.homeGoals) + g(m.awayGoals),
    goal_diff: g(m.homeGoals) - g(m.awayGoals),
    home_shots: g(m.shots?.home), away_shots: g(m.shots?.away),
    home_sot: g(m.shotsOnTarget?.home), away_sot: g(m.shotsOnTarget?.away),
    home_xg: g(m.xg?.home), away_xg: g(m.xg?.away),
    total_xg: g(m.xg?.home) + g(m.xg?.away),
    minute: g(m.minute),
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
    // Kural belirli bir maça bağlıysa sadece o maçta çalışır
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
