const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(Number(n)) ? Number(n) : lo));
const num = (v) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const pct = (v) => { const n = num(String(v ?? "").replace("%", "")); return n === null ? null : n > 1 ? n : n * 100; };
const avg = (a, b) => a == null && b == null ? null : a == null ? b : b == null ? a : (a + b) / 2;

function formScore(form) {
  if (!form) return null;
  const chars = String(form).toUpperCase().replace(/[^WDL]/g, "").slice(-5).split("");
  if (!chars.length) return null;
  return chars.reduce((s, c) => s + (c === "W" ? 3 : c === "D" ? 1 : 0), 0) / (chars.length * 3) * 100;
}

function teamSummary(raw, venue) {
  if (!raw) return null;
  const f = raw.fixtures || {}, goals = raw.goals || {};
  const played = num(f.played?.[venue]);
  const scored = num(goals.for?.average?.[venue]);
  const conceded = num(goals.against?.average?.[venue]);
  const winRaw = f.wins?.[venue]?.percentage ?? f.wins?.[venue]?.percent;
  const winCount = num(f.wins?.[venue]);
  const winPct = winRaw != null ? pct(winRaw) : played && winCount != null ? winCount / played * 100 : null;
  const lossRaw = f.loses?.[venue]?.percentage ?? f.loses?.[venue]?.percent;
  const lossCount = num(f.loses?.[venue]);
  const lossPct = lossRaw != null ? pct(lossRaw) : played && lossCount != null ? lossCount / played * 100 : null;
  return { played, scored, conceded, winPct, lossPct };
}

function impliedOdds(odds) {
  if (!odds) return null;
  const o = num(odds.over25), u = num(odds.under25);
  if (o == null || u == null || o <= 1 || u <= 1) return null;
  const po = 1 / o, pu = 1 / u;
  return po / (po + pu);
}

function tableTeam(standings, teamId) {
  if (!Array.isArray(standings)) return null;
  return standings.find((r) => String(r.team?.id) === String(teamId)) || null;
}

export function scoreGoalContext(match, context = {}, live = {}) {
  const w10 = live.w10?.ready ? num(live.w10.score) : null;
  const w15 = live.w15?.ready ? num(live.w15.score) : null;
  const liveScore = w10 == null && w15 == null ? null : Math.max(w10 ?? 0, w15 ?? 0);

  const overProb = impliedOdds(context.preOdds);
  const oneXtwo = context.preOdds || {};
  const oddsVals = [num(oneXtwo.home), num(oneXtwo.draw), num(oneXtwo.away)].filter((v) => v != null && v > 1);
  const implied = oddsVals.length === 3 ? oddsVals.map((v) => 1 / v) : null;
  const impliedSum = implied?.reduce((a, b) => a + b, 0) || 0;
  const favoriteProb = impliedSum ? Math.max(...implied) / impliedSum : null;
  const drawProb = impliedSum ? implied[1] / impliedSum : null;
  const marketSignals = [];
  if (overProb != null) marketSignals.push({ value: overProb * 100, weight: 0.75 });
  if (drawProb != null) marketSignals.push({ value: (1 - drawProb) * 100, weight: 0.25 });
  const oddsScore = marketSignals.length ? clamp(marketSignals.reduce((a, b) => a + b.value * b.weight, 0) / marketSignals.reduce((a, b) => a + b.weight, 0)) : null;

  const home = teamSummary(context.homeStats, "home");
  const away = teamSummary(context.awayStats, "away");
  const homeOpp = teamSummary(context.homeStats, "home");
  const awayOpp = teamSummary(context.awayStats, "away");
  const expectedHome = home?.scored == null || awayOpp?.conceded == null ? null : (home.scored + awayOpp.conceded) / 2;
  const expectedAway = away?.scored == null || homeOpp?.conceded == null ? null : (away.scored + homeOpp.conceded) / 2;
  const expectedGoals = expectedHome == null && expectedAway == null ? null : (expectedHome || 0) + (expectedAway || 0);
  const venueScore = expectedGoals == null ? null : clamp(expectedGoals / 3.5 * 100);

  const homeTable = tableTeam(context.standings, match.homeId);
  const awayTable = tableTeam(context.standings, match.awayId);
  const form = avg(formScore(homeTable?.form), formScore(awayTable?.form));
  const win = avg(home?.winPct, away?.winPct);
  const tableSize = Array.isArray(context.standings) ? context.standings.length : 0;
  const rankScore = tableSize > 1 && homeTable && awayTable
    ? clamp(avg((1 - ((num(homeTable.rank) || tableSize) - 1) / (tableSize - 1)) * 100,
                (1 - ((num(awayTable.rank) || tableSize) - 1) / (tableSize - 1)) * 100))
    : null;
  const formValues = [form, win, rankScore].filter((v) => v != null);
  const formTableScore = formValues.length ? clamp(formValues.reduce((a, b) => a + b, 0) / formValues.length) : null;

  const minute = num(match.minute) || 0;
  const minuteScore = minute >= 20 && minute <= 78 ? 85 : minute >= 10 && minute <= 85 ? 65 : 40;
  const totalGoals = (num(match.homeGoals) || 0) + (num(match.awayGoals) || 0);
  const scoreState = totalGoals <= 1 ? 80 : totalGoals === 2 ? 65 : 40;
  const redTotal = (num(match.red?.home) || 0) + (num(match.red?.away) || 0);
  const matchContextScore = clamp(minuteScore * 0.55 + scoreState * 0.35 + (redTotal ? 10 : 0));

  const parts = [
    { key: "live", label: "Canlı hücum baskısı", value: liveScore, weight: 45 },
    { key: "odds", label: "Maç önü gol beklentisi", value: oddsScore, weight: 15 },
    { key: "venue", label: "İç saha / deplasman", value: venueScore, weight: 15 },
    { key: "form", label: "Puan durumu ve form", value: formTableScore, weight: 15 },
    { key: "game", label: "Dakika ve maç durumu", value: matchContextScore, weight: 10 },
  ];
  const available = parts.filter((p) => p.value != null);
  const weight = available.reduce((s, p) => s + p.weight, 0);
  const score = weight ? Math.round(available.reduce((s, p) => s + p.value * p.weight, 0) / weight) : null;
  const coverage = Math.round(weight);
  const level = score == null ? "Veri bekleniyor" : score >= 75 ? "Yüksek gol sinyali" : score >= 60 ? "Gol eğilimi" : score >= 40 ? "Orta" : "Düşük";
  const signal = score != null && score >= 75 && liveScore != null && liveScore >= 55 && coverage >= 60;
  return {
    ready: score != null, score, level, signal, coverage, livePressure: liveScore,
    probability: null, probabilityLabel: "Model henüz kalibre edilmedi",
    expectedGoals: expectedGoals == null ? null : +expectedGoals.toFixed(2),
    preOdds: context.preOdds || null,
    over25Probability: overProb == null ? null : +overProb.toFixed(3),
    favoriteProbability: favoriteProb == null ? null : +favoriteProb.toFixed(3),
    drawProbability: drawProb == null ? null : +drawProb.toFixed(3),
    components: parts.map((p) => ({ ...p, value: p.value == null ? null : Math.round(p.value) })),
    context: {
      homeRank: num(homeTable?.rank), awayRank: num(awayTable?.rank),
      homePoints: num(homeTable?.points), awayPoints: num(awayTable?.points),
      homeForm: homeTable?.form || null, awayForm: awayTable?.form || null,
      homeScored: home?.scored ?? null, homeConceded: home?.conceded ?? null,
      awayScored: away?.scored ?? null, awayConceded: away?.conceded ?? null,
    },
  };
}

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
export function trainingVector(prediction) {
  const vals = [
    (prediction?.livePressure ?? 0) / 100,
    (prediction?.over25Probability ?? 0.5),
    (prediction?.expectedGoals ?? 1.8) / 4,
    (prediction?.components?.find((x) => x.key === "form")?.value ?? 50) / 100,
    (prediction?.components?.find((x) => x.key === "game")?.value ?? 50) / 100,
    (prediction?.coverage ?? 0) / 100,
  ];
  return vals.map((v) => Math.max(0, Math.min(1, Number(v) || 0)));
}

export function trainLogistic(samples, oldWeights = null) {
  const valid = (samples || []).filter((s) => Array.isArray(s.x) && s.x.length === 6 && (s.y === 0 || s.y === 1));
  const positives = valid.filter((s) => s.y === 1).length;
  if (valid.length < 250 || positives < 25 || valid.length - positives < 50) return null;
  let w = Array.isArray(oldWeights) && oldWeights.length === 7 ? [...oldWeights] : [ -2.1, 1.7, 0.8, 0.7, 0.3, 0.2, 0.3 ];
  const lr = 0.04, lambda = 0.015;
  for (let epoch = 0; epoch < 700; epoch++) {
    const grad = Array(7).fill(0);
    for (const s of valid) {
      const z = w[0] + s.x.reduce((sum, v, i) => sum + w[i + 1] * v, 0);
      const err = sigmoid(z) - s.y;
      grad[0] += err;
      for (let i = 0; i < 6; i++) grad[i + 1] += err * s.x[i];
    }
    for (let i = 0; i < 7; i++) {
      grad[i] = grad[i] / valid.length + (i ? lambda * w[i] : 0);
      w[i] -= lr * grad[i];
    }
  }
  return { weights: w, samples: valid.length, positives, trainedAt: Date.now() };
}

export function predictTrainedProbability(vector, weights) {
  if (!Array.isArray(weights) || weights.length !== 7 || !Array.isArray(vector) || vector.length !== 6) return null;
  const z = weights[0] + vector.reduce((sum, v, i) => sum + weights[i + 1] * v, 0);
  return sigmoid(z);
}
