import express from "express";
import fs from "fs";
import path from "path";
import { findTriggered, formatAlert } from "./rules.mjs";

const env = process.env;
const { BOT_TOKEN, CHAT_ID, PANEL_PASSWORD, API_KEY, DATA_DIR = ".", TIMEZONE = "Europe/Istanbul", BOOKMAKER_ID = "8" } = env;
const sec = (v, def, min) => Math.max(min, Number(v) || def);
const POLL = sec(env.POLL_SECONDS, 30, 15);   // canlı skor aralığı
const STATS = sec(env.STATS_SECONDS, 60, 30); // şut/xG aralığı (maç başına)
const ODDS = sec(env.ODDS_SECONDS, 60, 30);   // canlı oran aralığı
const LIST = sec(env.LIST_SECONDS, 600, 120); // günlük maç programı aralığı
const LEAGUES = (env.LEAGUE_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

if (!BOT_TOKEN || !CHAT_ID || !PANEL_PASSWORD) {
  console.error("Eksik ortam değişkeni: BOT_TOKEN, CHAT_ID ve PANEL_PASSWORD gerekli.");
  process.exit(1);
}

// ---------- Kurallar ----------
const RULES_FILE = path.join(DATA_DIR, "rules.json");
const loadRules = () => {
  try { return JSON.parse(fs.readFileSync(RULES_FILE, "utf8")).rules || []; }
  catch { return []; }
};
const saveRules = (rules) => fs.writeFileSync(RULES_FILE, JSON.stringify({ rules }, null, 2));

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
    id: f.fixture.id,
    home: f.teams.home.name, away: f.teams.away.name,
    homeId: f.teams.home.id, awayId: f.teams.away.id,
    minute: f.fixture.status.elapsed ?? 0,
    status: label, short: s, inPlay: IN_PLAY.has(s),
    homeGoals: f.goals.home, awayGoals: f.goals.away,
    kickoff: f.fixture.timestamp,
  };
}

// 1-X-2 oranlarını bahis listesinden çıkarır
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

function parseStats(resp, m) {
  const out = { shots: {}, sot: {}, xg: {} };
  for (const t of resp) {
    const side = t.team.id === m.homeId ? "home" : t.team.id === m.awayId ? "away" : null;
    if (!side || !t.statistics?.length) continue;
    const g = (type) => t.statistics.find((s) => s.type === type)?.value;
    out.shots[side] = Number(g("Total Shots") ?? 0);
    out.sot[side] = Number(g("Shots on Goal") ?? 0);
    const xg = g("expected_goals");
    out.xg[side] = xg == null ? null : Number(xg);
  }
  return out;
}

// Kuralların hangi veriye ihtiyacı olduğunu bulur (gereksiz istek atmamak için)
function needs(rules, m) {
  const n = { stats: false, live: false, pre: false };
  for (const r of rules) {
    if (r.matchId && String(r.matchId) !== String(m.id)) continue;
    for (const c of r.conditions || []) {
      if (c.metric.startsWith("pre_")) n.pre = true;
      else if (c.metric.startsWith("live_")) n.live = true;
      else if (/shots|sot|xg/.test(c.metric)) n.stats = true;
    }
  }
  return n;
}

// ---------- Takip döngüsü ----------
let schedule = [], scheduleAt = 0;
let liveMap = new Map();
let liveOdds = new Map(), liveOddsAt = 0;
const extra = new Map(); // maç id -> { stats, statsAt, pre, preAt }
let cache = { matches: [], updated: null, error: "" };
let lastLog = "";
let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  const warns = [];
  const safe = async (fn) => { try { await fn(); } catch (e) { warns.push(e.message); } };
  try {
    if (!API_KEY) { cache.error = "API_KEY tanımlı değil"; return; }
    const now = Date.now();
    const rules = loadRules().filter((r) => r.enabled);

    // 1) Günün maç programı
    if (now - scheduleAt > LIST * 1000) {
      scheduleAt = now;
      try {
        schedule = (await api(`/fixtures?date=${today()}&timezone=${encodeURIComponent(TIMEZONE)}`)).filter(wanted).map(norm);
      } catch (e) {
        scheduleAt = now - (LIST - 60) * 1000; // 1 dakika sonra tekrar dene
        warns.push(e.message);
      }
    }

    // 2) Canlı skorlar (sadece canlı maç varsa ya da başlamak üzereyse)
    const soon = schedule.some((m) => m.inPlay || (m.short === "NS" && Math.abs(m.kickoff * 1000 - now) < 600000));
    if (soon || liveMap.size) {
      await safe(async () => {
        const list = (await api(`/fixtures?live=${LEAGUES.length ? LEAGUES.join("-") : "all"}`)).filter(wanted).map(norm);
        liveMap = new Map(list.map((m) => [m.id, m]));
        if (schedule.some((s) => s.inPlay && !liveMap.has(s.id))) {
          scheduleAt = Math.min(scheduleAt, now - (LIST - 60) * 1000); // biten maçı programdan güncelle
        }
      });
    }

    // 3) Program ve canlı veriyi birleştir
    const byId = new Map(schedule.map((m) => [m.id, m]));
    for (const m of liveMap.values()) byId.set(m.id, { ...byId.get(m.id), ...m });
    const all = [...byId.values()];
    cache = { matches: all, updated: now, error: "" };
    const playing = all.filter((m) => m.inPlay);

    // 4) Canlı oranlar (tek istek, tüm canlı maçlar)
    if (playing.some((m) => needs(rules, m).live) && now - liveOddsAt > ODDS * 1000) {
      liveOddsAt = now;
      await safe(async () => {
        const resp = await api("/odds/live");
        liveOdds = new Map(resp.map((o) => [o.fixture.id, pick1x2(o.odds, /^(fulltime result|match winner)$/i)]));
      });
    }

    // 5) Şut/xG ve maç önü oranları (sadece kuralı olan maçlar için)
    let preBudget = 5; // bir turda en fazla 5 maç önü oran isteği
    for (const m of all) {
      const upcoming = m.short === "NS" && m.kickoff * 1000 - now < 3 * 3600000;
      if (!m.inPlay && !upcoming) continue;
      const n = needs(rules, m);
      if (!n.stats && !n.pre) continue;
      const x = extra.get(m.id) || {};
      extra.set(m.id, x);
      if (n.stats && m.inPlay && now - (x.statsAt || 0) > STATS * 1000) {
        x.statsAt = now;
        await safe(async () => { x.stats = parseStats(await api(`/fixtures/statistics?fixture=${m.id}`), m); });
      }
      if (n.pre && preBudget > 0 && (x.preAt === undefined || (!x.pre && now - x.preAt > 1800000))) {
        preBudget--;
        x.preAt = now;
        await safe(async () => {
          const r = await api(`/odds?fixture=${m.id}&bookmaker=${BOOKMAKER_ID}`);
          x.pre = pick1x2(r[0]?.bookmakers?.[0]?.bets, /^match winner$/i);
        });
      }
    }
    for (const id of extra.keys()) if (!byId.has(id)) extra.delete(id);

    // 6) Kuralları değerlendir
    for (const m of playing) {
      const x = extra.get(m.id) || {};
      const full = { ...m, preOdds: x.pre, liveOdds: liveOdds.get(m.id), shots: x.stats?.shots, shotsOnTarget: x.stats?.sot, xg: x.stats?.xg };
      for (const rule of findTriggered(rules, full)) {
        await safe(async () => {
          await sendTelegram(formatAlert(full, rule));
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

// ---------- Web paneli ----------
const app = express();
app.use(express.json());
app.use(express.static("public"));

const auth = (req, res, next) =>
  req.get("x-password") === PANEL_PASSWORD ? next() : res.status(401).end();

app.get("/api/rules", auth, (req, res) => res.json({ rules: loadRules() }));

app.post("/api/rules", auth, (req, res) => {
  const rules = req.body?.rules;
  if (!Array.isArray(rules)) return res.status(400).json({ error: "geçersiz veri" });
  saveRules(rules);
  res.json({ ok: true });
});

app.get("/api/matches", auth, (req, res) => {
  res.json({
    matches: cache.matches.map(({ id, home, away, minute, status, homeGoals, awayGoals }) =>
      ({ id, home, away, minute, status, homeGoals, awayGoals })),
    updated: cache.updated,
    error: cache.error,
  });
});

app.post("/api/test", auth, async (req, res) => {
  try {
    await sendTelegram("✅ Test mesajı: bağlantı çalışıyor.");
    res.json({ ok: true });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: "gönderilemedi" });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Panel hazır."));
