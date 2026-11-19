import express from "express";
import fs from "fs";
import path from "path";
import { findTriggered, formatAlert } from "./rules.mjs";

const { BOT_TOKEN, CHAT_ID, PANEL_PASSWORD, SCORE_API_URL, DATA_DIR = ".", POLL_SECONDS = "20" } = process.env;

if (!BOT_TOKEN || !CHAT_ID || !PANEL_PASSWORD) {
  console.error("Eksik ortam değişkeni: BOT_TOKEN, CHAT_ID ve PANEL_PASSWORD gerekli.");
  process.exit(1);
}

const RULES_FILE = path.join(DATA_DIR, "rules.json");
const loadRules = () => {
  try { return JSON.parse(fs.readFileSync(RULES_FILE, "utf8")).rules || []; }
  catch { return []; }
};
const saveRules = (rules) => fs.writeFileSync(RULES_FILE, JSON.stringify({ rules }, null, 2));

async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  });
  if (!r.ok) throw new Error("Telegram hatası: " + (await r.text()));
}

// SENİN API'NE UYARLANACAK KISIM
// status: API maç durumu veriyorsa (ör. "MS", "Devre arası") ekle, yoksa boş bırak.
async function fetchLiveMatches() {
  const r = await fetch(SCORE_API_URL);
  if (!r.ok) throw new Error("Skor API hatası: " + r.status);
  const data = await r.json();
  return data.matches.map((m) => ({
    id: m.id,
    home: m.homeName,
    away: m.awayName,
    minute: m.minute,
    status: m.status,
    homeGoals: m.homeScore,
    awayGoals: m.awayScore,
    preOdds: m.preOdds,
    liveOdds: m.liveOdds,
    shots: m.shots,
    shotsOnTarget: m.shotsOnTarget,
    xg: m.xg,
  }));
}

// Panelin maç listesi için son çekilen veri
let cache = { matches: [], updated: null, error: "" };

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (!SCORE_API_URL) {
      cache.error = "SCORE_API_URL tanımlı değil";
      return;
    }
    const matches = await fetchLiveMatches();
    cache = { matches, updated: Date.now(), error: "" };

    const rules = loadRules().filter((r) => r.enabled);
    for (const match of matches) {
      for (const rule of findTriggered(rules, match)) {
        await sendTelegram(formatAlert(match, rule));
        console.log("Gönderildi:", rule.name, match.home, "-", match.away);
      }
    }
  } catch (e) {
    cache.error = e.message;
    console.error("poll hatası:", e.message);
  } finally {
    polling = false;
  }
}
poll();
setInterval(poll, Math.max(5, Number(POLL_SECONDS)) * 1000);

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
