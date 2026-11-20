const num = (v) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const add = (a, b) => (a === null || b === null ? null : a + b);
const sub = (a, b) => (a === null || b === null ? null : a - b);
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Dönem anahtarı: "all" | "h1" | "h2" | "l<N>" (son N dakika)
const pkey = (c) => (c.period === "last" ? "l" + Math.max(1, Number(c.last) || 10) : c.period || "all");

export function toMetrics(m, period = "all") {
  const s = period === "h1" ? m.h1 || {} : period === "h2" ? m.h2 || {} : period.startsWith("l") ? m.lastWin?.[period] || {} : m;
  const hg = num(m.homeGoals), ag = num(m.awayGoals);
  const hx = num(s.xg?.home), ax = num(s.xg?.away);
  const hs = num(s.shots?.home), as = num(s.shots?.away);
  const ht = num(s.shotsOnTarget?.home), at = num(s.shotsOnTarget?.away);
  const hr = num(s.red?.home), ar = num(s.red?.away);
  return {
    pre_home: num(m.preOdds?.home), pre_draw: num(m.preOdds?.draw), pre_away: num(m.preOdds?.away), pre_over25: num(m.preOdds?.over25),
    live_home: num(m.liveOdds?.home), live_draw: num(m.liveOdds?.draw), live_away: num(m.liveOdds?.away), live_over25: num(m.liveOdds?.over25),
    home_goals: hg, away_goals: ag, total_goals: add(hg, ag), goal_diff: sub(hg, ag),
    home_shots: hs, away_shots: as, total_shots: add(hs, as),
    home_sot: ht, away_sot: at, total_sot: add(ht, at),
    home_xg: hx, away_xg: ax, total_xg: add(hx, ax),
    home_red: hr, away_red: ar, total_red: add(hr, ar),
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

export function ruleMatches(rule, match) {
  if (!rule.enabled || rule.draft || !rule.conditions?.length) return false;
  const min = num(match.minute);
  const from = num(rule.minFrom), to = num(rule.minTo);
  if (from !== null && (min === null || min < from)) return false;
  if (to !== null && (min === null || min > to)) return false;
  const cache = {};
  return rule.conditions.every((c) => {
    const p = pkey(c);
    const v = (cache[p] ||= toMetrics(match, p))[c.metric];
    return v !== null && v !== undefined && !Number.isNaN(v) && OPS[c.op]?.(v, Number(c.value));
  });
}

// Aynı maç + aynı koşullar + aynı dakika aralığı = aynı bildirim (kural adı önemli değil)
const sig = (r) => JSON.stringify([
  (r.conditions || []).map((c) => [c.metric, c.op, Number(c.value), pkey(c)]).sort(),
  num(r.minFrom), num(r.minTo),
]);

export function findTriggered(rules, match, fired = {}) {
  const seen = new Set(), out = [];
  for (const rule of rules) {
    if (rule.matchId && String(rule.matchId) !== String(match.id)) continue;
    const key = `${match.id}:${sig(rule)}`;
    if (fired[key] || seen.has(key) || !ruleMatches(rule, match)) continue;
    seen.add(key);
    out.push({ rule, key });
  }
  return out;
}

const COUNTRY = { Turkey: "Türkiye", England: "İngiltere", Spain: "İspanya", Germany: "Almanya", Italy: "İtalya", France: "Fransa", Netherlands: "Hollanda", Portugal: "Portekiz", Belgium: "Belçika", Scotland: "İskoçya", Greece: "Yunanistan", Russia: "Rusya", Brazil: "Brezilya", Argentina: "Arjantin", World: "Dünya", Switzerland: "İsviçre", Austria: "Avusturya", Denmark: "Danimarka", Sweden: "İsveç", Norway: "Norveç" };
const f = (v, d = 0) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "–" : Number(v).toFixed(d));
const odds = (o) => (o ? `1 ${f(o.home, 2)} · X ${f(o.draw, 2)} · 2 ${f(o.away, 2)} · 2.5Ü ${f(o.over25, 2)}` : "yok");

export function formatAlert(m, rule) {
  const total = add(num(m.shots?.home), num(m.shots?.away));
  return [
    `🔔 <b>${esc(rule.name)}</b>`,
    `🌍 ${esc(COUNTRY[m.country] || m.country || "–")}${m.league ? " · " + esc(m.league) : ""}`,
    `⏱ ${m.minute}' · <b>${esc(m.home)} ${m.homeGoals} - ${m.awayGoals} ${esc(m.away)}</b>`,
    `xG: ${f(m.xg?.home, 2)} - ${f(m.xg?.away, 2)}`,
    `Şut: ${f(m.shots?.home)} - ${f(m.shots?.away)} (toplam ${f(total)})`,
    `Maç önü: ${odds(m.preOdds)}`,
    `Şimdi: ${odds(m.liveOdds)}`,
  ].join("\n");
}
