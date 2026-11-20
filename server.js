
import express from "express";
import fs from "fs";
import path from "path";
import { findTriggered, formatAlert, condsMatch, toMetrics, pkey } from "./rules.mjs";

const env = process.env;
const { BOT_TOKEN, CHAT_ID, PANEL_PASSWORD, API_KEY, DATA_DIR = ".", TIMEZONE = "Europe/Istanbul", BOOKMAKER_ID = "8" } = env;
const sec = (v, def, min) => Math.max(min, Number(v) || def);
const POLL = 60;                 // canlı maç listesi ve kontrol döngüsü: 60 saniye
const STATS = 60;                // istatistik güncelleme kontrolü: 60 saniye
const STATS_BATCH_SIZE = 20;    // /fixtures?ids= tek istekte en fazla 20 maç
const FINAL_CHECK = 10 * 60;      // bildirimli maçların bitiş skorunu 10 dakikada bir kontrol et
const REQUIRE_XG = true; // xG verisi olmayan maçlarda hiçbir bildirim gönderilmez.
const LEAGUES = (env.LEAGUE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

if (!BOT_TOKEN || !CHAT_ID || !PANEL_PASSWORD) {
  console.error("Eksik ortam değişkeni: BOT_TOKEN, CHAT_ID ve PANEL_PASSWORD gerekli.");
  process.exit(1);
}

// ---------- Kayıtlar ----------
const RULES_FILE = path.join(DATA_DIR, "rules.json");
const FIRED_FILE = path.join(DATA_DIR, "fired.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const NOTIFICATIONS_FILE = path.join(DATA_DIR, "notifications.json");
const loadRules = () => { try { return JSON.parse(fs.readFileSync(RULES_FILE, "utf8")).rules || []; } catch { return []; } };
const saveRules = (rules) => fs.writeFileSync(RULES_FILE, JSON.stringify({ rules }, null, 2));

let fired = {};
try { fired = JSON.parse(fs.readFileSync(FIRED_FILE, "utf8")); } catch {}
for (const k of Object.keys(fired)) if (fired[k] < Date.now() - 3 * 86400000) delete fired[k];
const saveFired = () => { try { fs.writeFileSync(FIRED_FILE, JSON.stringify(fired)); } catch (e) { console.error("fired yazılamadı:", e.message); } };
let notifications = [];
try { notifications = JSON.parse(fs.readFileSync(NOTIFICATIONS_FILE, "utf8")); if (!Array.isArray(notifications)) notifications = []; } catch {}
const saveNotifications = () => {
  try { fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(notifications, null, 2)); }
  catch (e) { console.error("Bildirim geçmişi yazılamadı:", e.message); }
};
const localDate = (d = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: TIMEZONE }).format(d);
const FINISHED = new Set(["FT", "AET", "PEN", "AWD", "WO"]);

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

// Toplu maç verisi: /fixtures?ids= ile en fazla 20 maçın istatistikleri tek istekte alınır.
async function fetchStatsBatch(ids) {
  if (!ids.length) return new Map();
  const fixtures = await api(`/fixtures?ids=${ids.join("-")}&timezone=${encodeURIComponent(TIMEZONE)}`);
  return new Map(fixtures.map((f) => [Number(f.fixture?.id), f]));
}

// Gol olayları (dakikalarıyla). Kendi kalesine golde taraf, güncel skorla eşleşen yönle belirlenir.
async function fetchGoals(m) {
  const ev = (await api(`/fixtures/events?fixture=${m.id}`)).filter((e) => e.type === "Goal" && !/missed|cancel/i.test(e.detail || ""));
  const mk = (flip) => ev.map((e) => {
    let side = e.team?.id === m.homeId ? "home" : "away";
    if (flip && /own/i.test(e.detail || "")) side = side === "home" ? "away" : "home";
    return { minute: Number(e.time?.elapsed ?? 0), side };
  });
  const ok = (l) => l.filter((g) => g.side === "home").length === (m.homeGoals ?? 0) && l.filter((g) => g.side === "away").length === (m.awayGoals ?? 0);
  const a = mk(false), b = mk(true);
  return ok(a) ? a : ok(b) ? b : a;
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
        out[p][k][side] = k === "xg" ? (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v)) : Number(v ?? 0);
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

// ---------- Zaman pencereleri: yarı, son N dk, dakika aralığı ----------
// Şut/xG/kart: izlenen anlık kayıtlardan (geçmiş) hesaplanır. Gol: gol olaylarından.
const copyB = (b) => ({ shots: { ...b.shots }, sot: { ...b.sot }, xg: { ...b.xg }, red: { ...b.red } });
function record(x, m) {
  if (!x.stats || !has(x.stats.all)) return;
  // Son 10 dakika tablosu için tam istatistik satırlarını da sakla.
  const rows = {
    home: (x.stats.lists?.all?.home || []).map((v) => ({ type: v.type, value: v.value })),
    away: (x.stats.lists?.all?.away || []).map((v) => ({ type: v.type, value: v.value })),
  };
  const last = x.hist?.[x.hist.length - 1];
  if (last && last.minute === m.minute) x.hist.pop();
  (x.hist ||= []).push({ minute: m.minute, at: Date.now(), all: copyB(x.stats.all), rows });
  if (x.hist.length > 800) x.hist.shift();
}
const KEYS = [["shots", "shots"], ["shotsOnTarget", "sot"], ["xg", "xg"], ["red", "red"]];
const emptyWin = () => ({ shots: {}, shotsOnTarget: {}, xg: {}, red: {} });
const histAt = (hist, minute) => { let b = null; for (const h of hist || []) { if (h.minute <= minute) b = h.all; else break; } return b; };
const histEntryAt = (hist, minute) => { let b = null; for (const h of hist || []) { if (h.minute <= minute) b = h; else break; } return b; };

function last10Rows(x, m) {
  const S = x.stats;
  if (!S) return [];
  const startMinute = Math.max(0, Number(m.minute || 0) - 10);
  const baseline = startMinute <= 0 ? null : histEntryAt(x.hist, startMinute);
  if (startMinute > 0 && !baseline) return [];
  const before = baseline?.rows || { home: [], away: [] };
  const home = S.lists?.all?.home || [];
  const away = S.lists?.all?.away || [];
  const nonDelta = /%|possession/i;
  const rows = [];
  for (const h of home) {
    if (nonDelta.test(h.type)) continue;
    const a = numv(h.value);
    const oldH = numv(before.home.find((v) => v.type === h.type)?.value);
    const oldA = numv(before.away.find((v) => v.type === h.type)?.value);
    const curA = numv(away.find((v) => v.type === h.type)?.value);
    if (a == null && curA == null) continue;
    rows.push({
      type: h.type,
      home: a == null ? null : Math.max(0, +(a - (oldH ?? 0)).toFixed(2)),
      away: curA == null ? null : Math.max(0, +(curA - (oldA ?? 0)).toFixed(2)),
    });
  }
  return rows;
}

function rangeBlock(hist, curMin, cur, a, b) {
  const r = emptyWin();
  const end = curMin <= b ? cur : histAt(hist, b);
  const start = a <= 0 ? "zero" : histAt(hist, a);
  if (!end || !start) return r; // yeterli geçmiş yok
  for (const [k, kk] of KEYS) for (const s of ["home", "away"]) {
    const e = end[kk][s], st = start === "zero" ? 0 : start[kk][s];
    r[k][s] = e == null || st == null ? null : Math.max(0, +(e - st).toFixed(3));
  }
  return r;
}
const cntGoals = (list, a, b) => { const r = { home: 0, away: 0 }; for (const g of list) if (g.minute >= a && g.minute <= b) r[g.side]++; return r; };

function buildWin(keys, m, x) {
  const S = x.stats, win = {};
  for (const key of keys) {
    let a, b;
    if (key === "h1") [a, b] = [0, 45];
    else if (key === "h2") [a, b] = [46, 200];
    else if (key[0] === "l") { a = Math.max(0, m.minute - Number(key.slice(1))); b = 200; }
    else [a, b] = key.slice(1).split("-").map(Number);
    let st = emptyWin();
    if (S) st = key === "h1" ? { ...blk(S.h1) } : key === "h2" ? { ...blk(S.h2) } : rangeBlock(x.hist, m.minute, S.all, a, b);
    st.goals = x.goals ? cntGoals(x.goals, key[0] === "l" ? a + 1 : a, b) : {};
    win[key] = st;
  }
  return win;
}

const SCOPE = /goals|goal_diff|shots|sot|xg|red/, GOALM = /goals|goal_diff/, STATM = /shots|sot|xg|red/;
function condInfo(conds) {
  const keys = new Set();
  let goals = false;
  for (const c of conds) {
    if (!SCOPE.test(c.metric)) continue;
    const k = pkey(c);
    if (k === "all") continue;
    keys.add(k);
    if (GOALM.test(c.metric)) goals = true;
  }
  return { keys, goals };
}
const scopeConds = (rules, m) => rules.filter((r) => !r.matchId || String(r.matchId) === String(m.id)).flatMap((r) => r.conditions || []);

// Bir maç için hangi veri gerektiğini kuralların metriklerinden çıkar.
function needs(rules, m) {
  const conditions = rules
    .filter((r) => !r.matchId || String(r.matchId) === String(m.id))
    .flatMap((r) => r.conditions || []);
  return {
    stats: conditions.some((c) => STATM.test(c.metric)),
    pre: conditions.some((c) => String(c.metric).startsWith("pre_")),
  };
}

// ---------- Takip döngüsü ----------
let schedule = [], scheduleDate = "", liveMap = new Map();
let finalCheckAt = 0, finalCursor = 0;
const extra = new Map();
let cache = { matches: [], updated: null, error: "" };
let lastLog = "", polling = false;

function addNotification(m, rule, minute, sentAt) {
  notifications.push({
    id: `${m.id}-${sentAt}-${Math.random().toString(36).slice(2, 8)}`,
    fixtureId: String(m.id), home: m.home, away: m.away,
    country: m.country || "", league: m.league || "", ruleName: rule.name || "Kural",
    minute: Number(minute) || 0,
    sentAt, date: localDate(new Date(sentAt)),
    scoreAt: { home: m.homeGoals ?? null, away: m.awayGoals ?? null },
    finalScore: null, finalStatus: null, finishedAt: null,
  });
  // Dosyanın sınırsız büyümesini önle; yaklaşık son 1 yıllık geçmişi tut.
  const cutoff = Date.now() - 366 * 86400000;
  notifications = notifications.filter((n) => n.sentAt >= cutoff).slice(-30000);
  saveNotifications();
}

async function updateFinalScores() {
  const pending = [...new Set(notifications.filter((n) => !n.finalScore).map((n) => String(n.fixtureId)))];
  if (!pending.length) return;
  const start = finalCursor % pending.length;
  const ids = pending.length <= 20 ? pending : pending.slice(start, start + 20);
  finalCursor = pending.length <= 20 ? 0 : (start + ids.length) % pending.length;
  const fixtures = await api(`/fixtures?ids=${ids.join("-")}&timezone=${encodeURIComponent(TIMEZONE)}`);
  let changed = false;
  for (const f of fixtures) {
      const status = f.fixture?.status?.short;
      if (!FINISHED.has(status)) continue;
      const finalScore = { home: f.goals?.home ?? null, away: f.goals?.away ?? null };
      const id = String(f.fixture.id);
      for (const n of notifications) {
        if (String(n.fixtureId) !== id || n.finalScore) continue;
        n.finalScore = finalScore;
        n.finalStatus = status;
        n.finishedAt = Date.now();
        changed = true;
      }
      // Günlük fikstür kaydını da final skorla güncelle.
      const sm = schedule.find((m) => String(m.id) === id);
      if (sm) {
        sm.homeGoals = finalScore.home; sm.awayGoals = finalScore.away;
        sm.short = status; sm.status = TR[status] || status; sm.inPlay = false;
      }
  }
  if (changed) saveNotifications();
}

async function poll() {
  if (polling || !active) return;
  polling = true;
  const warns = [];
  const safe = async (fn) => { try { await fn(); } catch (e) { warns.push(e.message); } };
  try {
    if (!API_KEY) { cache.error = "API_KEY tanımlı değil"; return; }
    const now = Date.now();
    const rules = loadRules().filter((r) => r.enabled && !r.draft);

    // Günlük fikstür yalnızca yerel gün değişince yenilenir.
    const day = today();
    if (scheduleDate !== day) {
      try {
        const fresh = (await api(`/fixtures?date=${day}&timezone=${encodeURIComponent(TIMEZONE)}`)).filter(wanted).map(norm);
        schedule = fresh;
        scheduleDate = day;
      } catch (e) { warns.push(`Fikstür: ${e.message}`); }
    }

    // Canlı maç listesi dakikada bir güncellenir.
    await safe(async () => {
      const list = (await api(`/fixtures?live=${LEAGUES.length ? LEAGUES.join("-") : "all"}`)).filter(wanted).map(norm);
      liveMap = new Map(list.map((m) => [m.id, m]));
    });

    const byId = new Map(schedule.map((m) => [m.id, m]));
    for (const m of liveMap.values()) byId.set(m.id, { ...byId.get(m.id), ...m });
    const all = [...byId.values()];
    const playing = all.filter((m) => m.inPlay);

    // Filtreler yalnızca bu önbelleği okur; filtre isteği hiçbir API sorgusu başlatmaz.
    const statCandidates = playing.filter((m) => RUNNING.has(m.short))
      .map((m) => ({ m, x: extra.get(m.id) || {} }))
      .sort((a, b) => (a.x.statsAt || 0) - (b.x.statsAt || 0));
    // Tüm canlı maçların istatistikleri toplu çekilir: her 20 maç için 1 API isteği.
    const statTasks = [];
    let statsBatchCount = 0;
    for (let i = 0; i < statCandidates.length; i += STATS_BATCH_SIZE) {
      const batch = statCandidates.slice(i, i + STATS_BATCH_SIZE);
      statsBatchCount++;
      for (const { m, x } of batch) {
        extra.set(m.id, x);
        x.statsAt = now;
      }
      statTasks.push(safe(async () => {
        const byFixture = await fetchStatsBatch(batch.map(({ m }) => m.id));
        for (const { m, x } of batch) {
          const fixture = byFixture.get(Number(m.id));
          if (!fixture) continue;
          x.stats = parseStats(fixture.statistics || [], m);
          // Toplu fixture yanıtı olayları da içeriyorsa, gol koşulları için sakla.
          if (Array.isArray(fixture.events)) {
            x.events = fixture.events;
            const goalEvents = fixture.events.filter((e) => e.type === "Goal" && !/missed|cancel/i.test(e.detail || ""));
            const mk = (flip) => goalEvents.map((e) => {
              let side = e.team?.id === m.homeId ? "home" : "away";
              if (flip && /own/i.test(e.detail || "")) side = side === "home" ? "away" : "home";
              return { minute: Number(e.time?.elapsed ?? 0), side };
            });
            const ok = (list) => list.filter((g) => g.side === "home").length === (m.homeGoals ?? 0) && list.filter((g) => g.side === "away").length === (m.awayGoals ?? 0);
            const a = mk(false), b = mk(true);
            x.goals = ok(a) ? a : ok(b) ? b : a;
            x.evTotal = (m.homeGoals ?? 0) + (m.awayGoals ?? 0);
            x.evAt = now;
          }
          record(x, m);
          x.detail = null;
        }
      }));
    }

    // Gol dakikası gereken kurallar için olay verisi; yalnızca skor değiştiğinde.
    const otherTasks = [];
    let preBudget = 1, eventBudget = 1;
    for (const m of all) {
      if (!m.inPlay) continue;
      const x = extra.get(m.id) || {};
      extra.set(m.id, x);
      const conditions = rules
        .filter((r) => !r.matchId || String(r.matchId) === String(m.id))
        .flatMap((r) => r.conditions || []);
      const info = condInfo(conditions);
      const goalTotal = (m.homeGoals ?? 0) + (m.awayGoals ?? 0);
      if (eventBudget > 0 && info.goals && !Array.isArray(x.events) && x.evTotal !== goalTotal && now - (x.evAt || 0) > 20000) {
        eventBudget--;
        x.evAt = now;
        otherTasks.push(safe(async () => { x.goals = await fetchGoals(m); x.evTotal = goalTotal; }));
      }
      if (preBudget > 0 && needs(rules, m).pre && x.preAt === undefined) {
        preBudget--; x.preAt = now;
        otherTasks.push(safe(async () => {
          const r = await api(`/odds?fixture=${m.id}&bookmaker=${BOOKMAKER_ID}`);
          x.pre = oddsSet(r[0]?.bookmakers?.[0]?.bets, false);
        }));
      }
    }

    await Promise.all([...statTasks, ...otherTasks]);

    // Bildirim kuralları. En az bir takımda sayısal xG varsa maç xG verisine sahip kabul edilir.
    let xgBlocked = 0;
    for (const m of playing) {
      const x = extra.get(m.id) || {};
      const S = x.stats;
      const relevant = rules.filter((r) => !r.matchId || String(r.matchId) === String(m.id));
      if (!relevant.length) continue;
      const homeXg = S?.all?.xg?.home;
      const awayXg = S?.all?.xg?.away;
      const homeHasXg = homeXg !== null && homeXg !== undefined && Number.isFinite(Number(homeXg));
      const awayHasXg = awayXg !== null && awayXg !== undefined && Number.isFinite(Number(awayXg));
      const hasXg = homeHasXg || awayHasXg;
      if (!hasXg) {
        xgBlocked++;
        continue;
      }
      const winKeys = condInfo(relevant.flatMap((r) => r.conditions || [])).keys;
      const full = {
        ...m, preOdds: x.pre || null, liveOdds: null,
        shots: S?.all.shots, shotsOnTarget: S?.all.sot, xg: S?.all.xg, red: S?.all.red,
        win: buildWin(winKeys, m, x),
      };
      const readyRules = relevant.filter((r) => {
        const usesStats = (r.conditions || []).some((c) => STATM.test(c.metric));
        if (usesStats && !S) return false;
        return true;
      });
      for (const { rule, key } of findTriggered(readyRules, full, fired)) {
        await safe(async () => {
          const sentAt = Date.now();
          await sendTelegram(formatAlert(full, rule));
          fired[key] = sentAt;
          saveFired();
          addNotification(full, rule, m.minute, sentAt);
          console.log("Gönderildi:", rule.name, m.home, "-", m.away, `${m.homeGoals}-${m.awayGoals}`);
        });
      }
    }

    // Bildirim giden maçların nihai skorlarını toplu sorguyla al.
    if (now - finalCheckAt >= FINAL_CHECK * 1000) {
      finalCheckAt = now;
      await safe(updateFinalScores);
    }

    cache = { matches: all, updated: now, error: warns[0] || "" };
    const log = `[poll] fikstür=${schedule.length} canlı=${liveMap.size} istatistik_maç=${statCandidates.length} istatistik_toplu_istek=${statsBatchCount} xG_verisi_yok=${xgBlocked} bildirim=${notifications.length} kalan_istek=${quota ?? "?"}`;
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

// Maç detayı sadece önbellekten üretilir; API çağrısı yapmaz.
function detail(m) {
  const x = extra.get(m.id) || {};
  const S = x.stats;
  const sum = (o) => (o?.home != null && o?.away != null ? o.home + o.away : null);
  const tot = (b) => ({ shots: sum(b.shots), sot: sum(b.sot), xg: sum(b.xg), red: sum(b.red) });
  const l10 = S ? rangeBlock(x.hist, m.minute, S.all, Math.max(0, m.minute - 10), 200) : emptyWin();
  return {
    stats: S ? { all: rowsOf(S, "all", m), h1: rowsOf(S, "h1", m), h2: rowsOf(S, "h2", m), l10: last10Rows(x, m) } : { all: [], h1: [], h2: [], l10: [] },
    totals: S ? { all: tot(S.all), h1: tot(S.h1), h2: tot(S.h2), l10: { shots: sum(l10.shots), sot: sum(l10.shotsOnTarget), xg: sum(l10.xg), red: sum(l10.red) } } : { all: {}, h1: {}, h2: {}, l10: {} },
    odds: { pre: x.pre || null, live: null },
    updated: x.statsAt || null,
    warn: !S ? "İstatistik henüz önbelleğe alınmadı; sıradaki güncellemede gelecek." : (m.minute >= 10 && !last10Rows(x, m).length ? "Son 10 dakika verisi için en az 10 dakikalık kayıt birikmesi gerekiyor. Yeni maç takibinde otomatik dolacak." : ""),
  };
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
  if (active) { scheduleDate = ""; liveMap = new Map(); poll(); }
  console.log("Durum:", active ? "AKTİF" : "PASİF");
  res.json({ active });
});

app.get("/api/matches", auth, (req, res) => {
  res.json({
    matches: cache.matches.map(({ id, home, away, minute, status, homeGoals, awayGoals, country, league, short, kickoff }) => ({ id, home, away, minute, status, homeGoals, awayGoals, country, league, short, kickoff })),
    updated: cache.updated,
    error: cache.error,
    active,
  });
});

app.get("/api/match/:id", auth, (req, res) => {
  const m = cache.matches.find((x) => String(x.id) === req.params.id);
  if (!m) return res.status(404).json({ error: "maç bulunamadı" });
  res.json(detail(m));
});

app.get("/api/notifications", auth, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || "")) ? String(req.query.date) : today();
  const filter = ["all", "finished", "pending"].includes(req.query.filter) ? req.query.filter : "all";
  const dayItems = notifications.filter((n) => n.date === date).sort((a, b) => b.sentAt - a.sentAt);
  const counts = {
    notifications: dayItems.length,
    matches: new Set(dayItems.map((n) => String(n.fixtureId))).size,
    finished: new Set(dayItems.filter((n) => n.finalScore).map((n) => String(n.fixtureId))).size,
    pending: new Set(dayItems.filter((n) => !n.finalScore).map((n) => String(n.fixtureId))).size,
  };
  const visible = filter === "finished" ? dayItems.filter((n) => n.finalScore)
    : filter === "pending" ? dayItems.filter((n) => !n.finalScore) : dayItems;
  res.json({ date, counts, items: visible, allItems: dayItems, updated: Date.now() });
});

app.get("/api/notifications/match/:id", auth, (req, res) => {
  const items = notifications.filter((n) => String(n.fixtureId) === String(req.params.id)).sort((a, b) => a.sentAt - b.sentAt);
  res.json({ items });
});

// Filtre yalnızca en son alınmış önbellek verisini değerlendirir; API çağrısı yoktur.
const OPSET = new Set([">=", ">", "<=", "<", "=="]);
const ALLOWED = /^((home|away|total)_(goals|shots|sot|xg|red)|goal_diff|minute)$/;
const cleanCond = (c) => ({
  metric: String(c.metric || ""), op: OPSET.has(c.op) ? c.op : ">=", value: Number(c.value),
  period: ["all", "h1", "h2", "last", "range"].includes(c.period) ? c.period : "all",
  last: Number(c.last) || 10, from: Number(c.from) || 0, to: Number(c.to) || 200,
});
app.post("/api/filter", auth, (req, res) => {
  const conditions = (req.body?.conditions || []).map(cleanCond).filter((c) => ALLOWED.test(c.metric) && Number.isFinite(c.value));
  const s = req.body?.sort;
  const sort = s && ALLOWED.test(s.metric || "") ? cleanCond({ ...s, value: 0 }) : null;
  const all = [...conditions, ...(sort ? [sort] : [])];
  const needStats = all.some((c) => STATM.test(c.metric));
  const info = condInfo(all);
  const rows = [];
  let pending = 0, total = 0;
  for (const m of cache.matches) {
    if (!m.inPlay) continue;
    total++;
    const x = extra.get(m.id) || {};
    const S = x.stats;
    if (needStats && !S) { pending++; continue; }
    const full = { ...m, shots: S?.all.shots, shotsOnTarget: S?.all.sot, xg: S?.all.xg, red: S?.all.red, win: buildWin(info.keys, m, x) };
    if (!condsMatch(conditions, full)) continue;
    const value = sort ? toMetrics(full, pkey(sort))[sort.metric] : null;
    rows.push({ id: m.id, home: m.home, away: m.away, minute: m.minute, status: m.status, homeGoals: m.homeGoals, awayGoals: m.awayGoals, xg: S?.all.xg || null, shots: S?.all.shots || null, value });
  }
  if (sort) rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  else rows.sort((a, b) => b.minute - a.minute);
  res.json({ rows: rows.slice(0, 100), total, pending, updated: cache.updated });
});

app.post("/api/test", auth, async (req, res) => {
  try { await sendTelegram("✅ Test mesajı: bağlantı çalışıyor."); res.json({ ok: true }); }
  catch (e) { console.error(e.message); res.status(500).json({ error: "gönderilemedi" }); }
});

app.listen(process.env.PORT || 3000, () => console.log("Panel hazır. Durum:", active ? "AKTİF" : "PASİF"));
