import express from "express";
import fs from "fs";
import path from "path";
import { findTriggered, formatAlert } from "./rules.mjs";

const env = process.env;
const { BOT_TOKEN, CHAT_ID, PANEL_PASSWORD, API_KEY, DATA_DIR = ".", TIMEZONE = "Europe/Istanbul", BOOKMAKER_ID = "8" } = env;
const sec = (v, def, min) => Math.max(min, Number(v) || def);
const POLL = sec(env.POLL_SECONDS, 15, 15);
const STATS = sec(env.STATS_SECONDS, 15, 15);
const ODDS = sec(env.ODDS_SECONDS, 15, 15);
const LIST = sec(env.LIST_SECONDS, 600, 120);
const REQUIRE_XG = env.REQUIRE_XG !== "0";
const LEAGUES = (env.LEAGUE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

if (!BOT_TOKEN || !CHAT_ID || !PANEL_PASSWORD) {
  console.error("Eksik ortam değişkeni: BOT_TOKEN, CHAT_ID ve PANEL_PASSWORD gerekli.");
  process.exit(1);
}

// ---------- Kayıtlar ----------
const RULES_FILE = path.join(DATA_DIR, "rules.json");
const FIRED_FILE = path.join(DATA_DIR, "fired.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const loadRules = () => { try { return JSON.parse(fs.readFileSync(RULES_FILE, "utf8")).rules || []; } catch { return []; } };
const saveRules = (rules) => fs.writeFileSync(RULES_FILE, JSON.stringify({ rules }, null, 2));

let fired = {};
try { fired = JSON.parse(fs.readFileSync(FIRED_FILE, "utf8")); } catch {}
for (const k of Object.keys(fired)) if (fired[k] < Date.now() - 3 * 86400000) delete fired[k];
const saveFired = () => { try { fs.writeFileSync(FIRED_FILE, JSON.stringify(fired)); } catch (e) { console.error("fired yazılamadı:", e.message); } };

let active = true; // pasifken API'ye hiç sorgu atılmaz
try { active = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")).active !== false; } catch {}

// ---------- Telegram ----------
async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  });
  if (!r.ok) throw new Error("Telegram hatası: " + (await r.text()));
}

// ---------- API-Football ----------
const API = "https://v3.football.api-sports.io";
let quota = null;
async function api(q) {
  const r = await fetch(API + q, { headers: { "x-apisports-key": API_KEY } });
  const left = r.headers.get("x-ratelimit-requests-remaining");
  if (left !== null) quota = Number(left);
  if (!r.ok) throw new Error("API hatası: " + r.status);
  const j = await r.json();
  const e = j.errors;
  if (e && (Array.isArray(e) ? e.length : Object.keys(e).length)) throw new Error("API: " + JSON.stringify(e));
  return j.response || [];
}

// half=true ile yarı istatistikleri de gelir; desteklenmezse otomatik düz istek
let halfOk = true, halfLogged = false;
async function fetchStats(id) {
  if (halfOk) {
    try {
      const r = await api(`/fixtures/statistics?fixture=${id}&half=true`);
      if (!halfLogged && r[0]) { halfLogged = true; console.log("[half] alanlar:", Object.keys(r[0]).join(",")); }
      return r;
    } catch (e) {
      if (/half/i.test(e.message)) halfOk = false; else throw e;
    }
  }
  return api(`/fixtures/statistics?fixture=${id}`);
}

const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: TIMEZONE }).format(new Date());
const IN_PLAY = new Set(["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "SUSP", "INT"]);
const RUNNING = new Set(["1H", "2H", "ET", "LIVE"]);
const TR = { FT: "MS", AET: "UZ", PEN: "PEN", HT: "D.A.", BT: "D.A.", P: "PEN", PST: "ERT", CANC: "İPT", SUSP: "ASK", INT: "ASK", ABD: "TRK", AWD: "HÜK", WO: "WO", TBD: "–" };
const wanted = (f) => !LEAGUES.length || LEAGUES.includes(String(f.league.id));

function norm(f) {
  const s = f.fixture.status.short;
  let label = "";
  if (!RUNNING.has(s)) {
    label = s === "NS"
      ? new Date(f.fixture.date).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: TIMEZONE })
      : TR[s] || s;
  }
  return {
    id: f.fixture.id, home: f.teams.home.name, away: f.teams.away.name,
    homeId: f.teams.home.id, awayId: f.teams.away.id,
    country: f.league.country, league: f.league.name,
    minute: f.fixture.status.elapsed ?? 0, status: label, short: s, inPlay: IN_PLAY.has(s),
    homeGoals: f.goals.home, awayGoals: f.goals.away, kickoff: f.fixture.timestamp,
  };
}

function pick1x2(bets, re) {
  const b = (bets || []).find((x) => re.test(x.name));
  if (!b) return null;
  const o = {};
  for (const v of b.values || []) {
    if (v.suspended) continue;
    const k = String(v.value).toLowerCase();
    if (k === "home" || k === "1") o.home = Number(v.odd);
    else if (k === "draw" || k === "x") o.draw = Number(v.odd);
    else if (k === "away" || k === "2") o.away = Number(v.odd);
  }
  return o.home || o.draw || o.away ? o : null;
}

function pickOU(bets, line = 2.5) {
  const bad = /half|1st|2nd|team|corner|card|asian|exact|both|btts/i;
  for (const b of bets || []) {
    if (!/over\/under|goals over|total goals/i.test(b.name) || bad.test(b.name)) continue;
    const o = {};
    for (const v of b.values || []) {
      if (v.suspended) continue;
      const val = String(v.value).toLowerCase();
      const hc = v.handicap != null && v.handicap !== "" ? Number(v.handicap) : null;
      if (!(hc !== null ? hc === line : val.includes(String(line)))) continue;
      if (val.startsWith("over")) o.over = Number(v.odd);
      else if (val.startsWith("under")) o.under = Number(v.odd);
    }
    if (o.over || o.under) return o;
  }
  return null;
}

function oddsSet(bets, live) {
  const w = pick1x2(bets, live ? /^(fulltime result|match winner)$/i : /^match winner$/i) || {};
  const ou = pickOU(bets) || {};
  const o = { ...w, over25: ou.over, under25: ou.under };
  return Object.values(o).some((v) => v) ? o : null;
}

// ---------- İstatistik ayrıştırma (tüm maç / 1. yarı / 2. yarı) ----------
const FIELDS = [["shots", "Total Shots"], ["sot", "Shots on Goal"], ["xg", "expected_goals"], ["red", "Red Cards"]];
const emptyBlock = () => ({ shots: {}, sot: {}, xg: {}, red: {} });
const has = (b) => b.shots.home !== undefined;
const diff = (a, b) => (a == null || b == null ? null : Math.max(0, +(a - b).toFixed(3)));
const numv = (v) => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null);

function parseStats(resp, m) {
  const out = { all: emptyBlock(), h1: emptyBlock(), h2: emptyBlock(), lists: { all: {}, h1: {}, h2: {} } };
  for (const t of resp) {
    const side = t.team.id === m.homeId ? "home" : t.team.id === m.awayId ? "away" : null;
    if (!side) continue;
    const put = (p, list) => {
      if (!Array.isArray(list) || !list.length) return;
      out.lists[p][side] = list;
      for (const [k, type] of FIELDS) {
        const v = list.find((s) => s.type === type)?.value;
        out[p][k][side] = k === "xg" ? (v == null ? null : Number(v)) : Number(v ?? 0);
      }
    };
    put("all", t.statistics);
    for (const [k, v] of Object.entries(t)) {
      if (k === "statistics" || !Array.isArray(v)) continue;
      if (/1h|first|1st/i.test(k)) put("h1", v);
      else if (/2h|second|2nd/i.test(k)) put("h2", v);
    }
  }
  // Eksik yarıyı tüm maçtan türet
  if (!has(out.h1) && (m.short === "1H" || m.short === "HT")) out.h1 = out.all;
  const mk = (x, y) => {
    const r = emptyBlock();
    for (const k of Object.keys(r)) for (const s of ["home", "away"]) if (x[k][s] !== undefined) r[k][s] = diff(x[k][s], y[k][s]);
    return r;
  };
  if (has(out.h1) && !has(out.h2) && m.short !== "1H" && m.short !== "HT") out.h2 = mk(out.all, out.h1);
  if (has(out.h2) && !has(out.h1)) out.h1 = mk(out.all, out.h2);
  return out;
}

const build = (H, A) => (H || []).map((s) => ({ type: s.type, home: s.value, away: A?.find((z) => z.type === s.type)?.value ?? null }));
const diffList = (a, b) => (a || []).map((s) => {
  const x = numv(s.value), y = numv(b?.find((z) => z.type === s.type)?.value);
  return { type: s.type, value: x == null || y == null ? null : +(x - y).toFixed(2) };
});
function rowsOf(S, p, m) {
  let H = S.lists[p].home, A = S.lists[p].away;
  if (!H && p === "h1" && (m.short === "1H" || m.short === "HT")) { H = S.lists.all.home; A = S.lists.all.away; }
  if (H) return build(H, A);
  const o = p === "h2" ? S.lists.h1 : p === "h1" ? S.lists.h2 : null;
  if (o?.home && S.lists.all.home) return build(diffList(S.lists.all.home, o.home), diffList(S.lists.all.away, o.away));
  return [];
}
const blk = (b) => ({ shots: b.shots, shotsOnTarget: b.sot, xg: b.xg, red: b.red });

// ---------- Son N dakika: geçmiş kayıtlarla hesaplanır (sunucu maçı izlediği sürece) ----------
const copyB = (b) => ({ shots: { ...b.shots }, sot: { ...b.sot }, xg: { ...b.xg }, red: { ...b.red } });
function record(x, m) {
  if (!x.stats || !has(x.stats.all)) return;
  (x.hist ||= []).push({ minute: m.minute, all: copyB(x.stats.all) });
  if (x.hist.length > 800) x.hist.shift();
}
function windowBlock(hist, minute, N, cur) {
  const r = { shots: {}, shotsOnTarget: {}, xg: {}, red: {} };
  const target = minute - N;
  let base = null;
  if (target > 0) {
    for (const h of hist || []) { if (h.minute <= target) base = h.all; else break; }
    if (!base) return r; // yeterli geçmiş yok
  }
  for (const [k, kk] of [["shots", "shots"], ["shotsOnTarget", "sot"], ["xg", "xg"], ["red", "red"]]) {
    for (const s of ["home", "away"]) {
      const c = cur[kk][s], b = base ? base[kk][s] : 0;
      r[k][s] = c == null || b == null ? null : Math.max(0, +(c - b).toFixed(3));
    }
  }
  return r;
}
function lastWins(rules, m, hist, cur) {
  const out = {};
  for (const r of rules) {
    if (r.matchId && String(r.matchId) !== String(m.id)) continue;
    for (const c of r.conditions || []) {
      if (c.period === "last") { const n = Math.max(1, Number(c.last) || 10); out["l" + n] = windowBlock(hist, m.minute, n, cur); }
    }
  }
  return out;
}
const lastTot = (hist, m, cur) => {
  const b = windowBlock(hist, m.minute, 10, cur);
  const s = (o) => (o.home != null && o.away != null ? o.home + o.away : null);
  return { shots: s(b.shots), sot: s(b.shotsOnTarget), xg: s(b.xg), red: s(b.red) };
};

// Bir kural bu maçı kapsıyorsa bildirim için tüm veriler (istatistik, oranlar) gerekir
const needs = (rules, m) => {
  const any = rules.some((r) => !r.matchId || String(r.matchId) === String(m.id));
  return { stats: any, live: any, pre: any };
};

// ---------- Takip döngüsü ----------
let schedule = [], scheduleAt = 0, liveMap = new Map();
let liveOdds = new Map(), liveOddsAt = 0;
const extra = new Map(); // id -> { stats, statsAt, hist, pre, preAt, detail, detailAt }
let cache = { matches: [], updated: null, error: "" };
let lastLog = "", polling = false;

async function poll() {
  if (polling || !active) return;
  polling = true;
  const warns = [];
  const safe = async (fn) => { try { await fn(); } catch (e) { warns.push(e.message); } };
  try {
    if (!API_KEY) { cache.error = "API_KEY tanımlı değil"; return; }
    const now = Date.now();
    const slow = quota !== null && quota < 500 ? 4 : 1;
    const rules = loadRules().filter((r) => r.enabled && !r.draft);

    if (now - scheduleAt > LIST * 1000) {
      scheduleAt = now;
      try {
        schedule = (await api(`/fixtures?date=${today()}&timezone=${encodeURIComponent(TIMEZONE)}`)).filter(wanted).map(norm);
      } catch (e) { scheduleAt = now - (LIST - 60) * 1000; warns.push(e.message); }
    }

    const soon = schedule.some((m) => m.inPlay || (m.short === "NS" && Math.abs(m.kickoff * 1000 - now) < 600000));
    if (soon || liveMap.size) {
      await safe(async () => {
        const list = (await api(`/fixtures?live=${LEAGUES.length ? LEAGUES.join("-") : "all"}`)).filter(wanted).map(norm);
        liveMap = new Map(list.map((m) => [m.id, m]));
        if (schedule.some((s) => s.inPlay && !liveMap.has(s.id))) scheduleAt = Math.min(scheduleAt, now - (LIST - 60) * 1000);
      });
    }

    const byId = new Map(schedule.map((m) => [m.id, m]));
    for (const m of liveMap.values()) byId.set(m.id, { ...byId.get(m.id), ...m });
    const all = [...byId.values()];
    cache = { matches: all, updated: now, error: "" };
    const playing = all.filter((m) => m.inPlay);

    if (playing.some((m) => needs(rules, m).live) && now - liveOddsAt > ODDS * 1000 * slow) {
      liveOddsAt = now;
      await safe(async () => {
        const resp = await api("/odds/live");
        liveOdds = new Map(resp.map((o) => [o.fixture.id, oddsSet(o.odds, true)]));
      });
    }

    const tasks = [];
    let preBudget = 5;
    for (const m of all) {
      const upcoming = m.short === "NS" && m.kickoff * 1000 - now < 3 * 3600000;
      if (!m.inPlay && !upcoming) continue;
      const n = needs(rules, m);
      if (!n.stats && !n.pre) continue;
      const x = extra.get(m.id) || {};
      extra.set(m.id, x);
      if (n.stats && RUNNING.has(m.short) && now - (x.statsAt || 0) > STATS * 1000 * slow) {
        x.statsAt = now;
        tasks.push(safe(async () => { x.stats = parseStats(await fetchStats(m.id), m); record(x, m); }));
      }
      if (n.pre && preBudget > 0 && (x.preAt === undefined || (!x.pre && now - x.preAt > 1800000))) {
        preBudget--;
        x.preAt = now;
        tasks.push(safe(async () => {
          const r = await api(`/odds?fixture=${m.id}&bookmaker=${BOOKMAKER_ID}`);
          x.pre = oddsSet(r[0]?.bookmakers?.[0]?.bets, false);
        }));
      }
    }
    await Promise.all(tasks);
    for (const id of extra.keys()) if (!byId.has(id)) extra.delete(id);

    for (const m of playing) {
      const x = extra.get(m.id) || {};
      const S = x.stats;
      const full = {
        ...m, preOdds: x.pre, liveOdds: liveOdds.get(m.id),
        shots: S?.all.shots, shotsOnTarget: S?.all.sot, xg: S?.all.xg, red: S?.all.red,
        h1: S && blk(S.h1), h2: S && blk(S.h2), lastWin: S && lastWins(rules, m, x.hist, S.all),
      };
      if (REQUIRE_XG && (full.xg?.home == null || full.xg?.away == null)) continue; // gol beklentisi yoksa bildirim yok
      for (const { rule, key } of findTriggered(rules, full, fired)) {
        await safe(async () => {
          await sendTelegram(formatAlert(full, rule));
          fired[key] = Date.now();
          saveFired();
          console.log("Gönderildi:", rule.name, m.home, "-", m.away);
        });
      }
    }

    cache.error = warns[0] || "";
    const log = `[poll] program=${schedule.length} canlı=${liveMap.size} kalan_istek=${quota ?? "?"}`;
    if (log !== lastLog) { console.log(log); lastLog = log; }
  } catch (e) {
    cache.error = e.message;
    console.error("poll hatası:", e.message);
  } finally {
    if (warns.length) console.error("uyarı:", warns.join(" | "));
    polling = false;
  }
}
poll();
setInterval(poll, POLL * 1000);

// Maç detayı: tüm istatistikler (tümü / 1. yarı / 2. yarı / son 10 dk özeti) ve oranlar
async function detail(m) {
  const now = Date.now();
  const x = extra.get(m.id) || {};
  extra.set(m.id, x);
  if (x.detail && now - x.detailAt < 14000) return x.detail;
  const warns = [];
  const safe = async (fn) => { try { await fn(); } catch (e) { warns.push(e.message); } };
  if (!x.statsAt || now - x.statsAt > 14000) {
    x.statsAt = now;
    await safe(async () => { x.stats = parseStats(await fetchStats(m.id), m); record(x, m); });
  }
  let live = null;
  if (m.inPlay) await safe(async () => { live = oddsSet((await api(`/odds/live?fixture=${m.id}`))[0]?.odds, true); });
  if (x.preAt === undefined || (!x.pre && now - x.preAt > 300000)) {
    x.preAt = now;
    await safe(async () => { x.pre = oddsSet((await api(`/odds?fixture=${m.id}&bookmaker=${BOOKMAKER_ID}`))[0]?.bookmakers?.[0]?.bets, false); });
  }
  const S = x.stats;
  const sum = (o) => (o?.home != null && o?.away != null ? o.home + o.away : null);
  const tot = (b) => ({ shots: sum(b.shots), sot: sum(b.sot), xg: sum(b.xg), red: sum(b.red) });
  x.detail = {
    stats: S ? { all: rowsOf(S, "all", m), h1: rowsOf(S, "h1", m), h2: rowsOf(S, "h2", m) } : { all: [], h1: [], h2: [] },
    totals: S ? { all: tot(S.all), h1: tot(S.h1), h2: tot(S.h2), l10: lastTot(x.hist, m, S.all) } : { all: {}, h1: {}, h2: {}, l10: {} },
    odds: { pre: x.pre || null, live },
    warn: warns[0] || "",
  };
  x.detailAt = Date.now();
  return x.detail;
}

// ---------- Web paneli ----------
const app = express();
app.use(express.json());
app.use(express.static("public"));

const auth = (req, res, next) => (req.get("x-password") === PANEL_PASSWORD ? next() : res.status(401).end());

app.get("/api/rules", auth, (req, res) => res.json({ rules: loadRules() }));
app.post("/api/rules", auth, (req, res) => {
  const rules = req.body?.rules;
  if (!Array.isArray(rules)) return res.status(400).json({ error: "geçersiz veri" });
  saveRules(rules.filter((r) => !r.draft));
  res.json({ ok: true });
});

app.get("/api/state", auth, (req, res) => res.json({ active }));
app.post("/api/state", auth, (req, res) => {
  active = !!req.body?.active;
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ active })); } catch (e) { console.error("settings yazılamadı:", e.message); }
  if (active) { scheduleAt = 0; liveMap = new Map(); poll(); }
  console.log("Durum:", active ? "AKTİF" : "PASİF");
  res.json({ active });
});

app.get("/api/matches", auth, (req, res) => {
  res.json({
    matches: cache.matches.map(({ id, home, away, minute, status, homeGoals, awayGoals }) => ({ id, home, away, minute, status, homeGoals, awayGoals })),
    updated: cache.updated,
    error: cache.error,
    active,
  });
});

app.get("/api/match/:id", auth, async (req, res) => {
  if (!active) return res.json({ passive: true });
  const m = cache.matches.find((x) => String(x.id) === req.params.id);
  if (!m) return res.status(404).json({ error: "maç bulunamadı" });
  try { res.json(await detail(m)); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/test", auth, async (req, res) => {
  try { await sendTelegram("✅ Test mesajı: bağlantı çalışıyor."); res.json({ ok: true }); }
  catch (e) { console.error(e.message); res.status(500).json({ error: "gönderilemedi" }); }
});

app.listen(process.env.PORT || 3000, () => console.log("Panel hazır. Durum:", active ? "AKTİF" : "PASİF"));
