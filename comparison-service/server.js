import express from "express";
import { Pool } from "pg";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.COMPARISON_API_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const FRESH_MS = Math.max(30_000, Number(process.env.SCORE_FRESH_MS || 120_000));
const SOURCES = new Set(["gol-bildirim", "claude", "gemini"]);
const FINISHED = new Set(["FT", "AET", "PEN", "AWD", "WO"]);

if (!TOKEN || !DATABASE_URL) {
  console.error("COMPARISON_API_TOKEN ve DATABASE_URL zorunludur.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: 5,
});

const schema = `
CREATE TABLE IF NOT EXISTS algorithm_score_snapshots (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  fixture_id TEXT NOT NULL,
  home TEXT,
  away TEXT,
  minute INTEGER,
  score NUMERIC(8,3),
  match_status TEXT,
  home_goals INTEGER,
  away_goals INTEGER,
  captured_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, fixture_id, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_algorithm_scores_lookup
  ON algorithm_score_snapshots (fixture_id, source, captured_at DESC);

CREATE TABLE IF NOT EXISTS algorithm_goal_notifications (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  fixture_id TEXT NOT NULL,
  home TEXT,
  away TEXT,
  minute INTEGER NOT NULL,
  score_at JSONB,
  source_score NUMERIC(8,3),
  score_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  notified_at TIMESTAMPTZ NOT NULL,
  goal_minutes JSONB NOT NULL DEFAULT '[]'::jsonb,
  match_status TEXT,
  final_score JSONB,
  outcome TEXT NOT NULL DEFAULT 'pending',
  outcome_goal_minute INTEGER,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, notification_id)
);
CREATE INDEX IF NOT EXISTS idx_algorithm_notifications_fixture
  ON algorithm_goal_notifications (fixture_id, notified_at);
`;

await pool.query(schema);

function auth(req, res, next) {
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!supplied || supplied !== TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}
app.use("/v1", auth);

function validSource(value) {
  return SOURCES.has(String(value || ""));
}
function asDate(value, fallback = new Date()) {
  const d = value ? new Date(value) : fallback;
  return Number.isNaN(d.getTime()) ? null : d;
}
function evaluate(notification, goalMinutes, finished) {
  const start = Number(notification.minute);
  const after = (goalMinutes || []).map(Number).filter(m => Number.isFinite(m) && m > start).sort((a,b)=>a-b);
  const within = after.find(m => m - start <= 10);
  if (within != null) return { outcome: "hit_10m", goalMinute: within, resolved: true };
  const later = after.find(m => m - start > 10);
  if (later != null) return { outcome: "late_goal", goalMinute: later, resolved: true };
  if (finished) return { outcome: "no_goal", goalMinute: null, resolved: true };
  return { outcome: "window_passed", goalMinute: null, resolved: false };
}

app.get("/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, service: "algorithm-comparison" }); }
  catch { res.status(503).json({ ok: false }); }
});

app.post("/v1/scores", async (req, res) => {
  const b = req.body || {};
  if (!validSource(b.source) || !b.fixture_id || !Number.isFinite(Number(b.score))) {
    return res.status(400).json({ error: "source, fixture_id ve sayısal score gerekli" });
  }
  const capturedAt = asDate(b.captured_at);
  if (!capturedAt) return res.status(400).json({ error: "captured_at geçersiz" });
  try {
    await pool.query(`
      INSERT INTO algorithm_score_snapshots
        (source, fixture_id, home, away, minute, score, match_status, home_goals, away_goals, captured_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (source, fixture_id, captured_at) DO NOTHING
    `, [
      b.source, String(b.fixture_id), b.home || null, b.away || null,
      Number.isFinite(Number(b.minute)) ? Number(b.minute) : null,
      Number(b.score), b.match_status || null,
      Number.isFinite(Number(b.home_goals)) ? Number(b.home_goals) : null,
      Number.isFinite(Number(b.away_goals)) ? Number(b.away_goals) : null,
      capturedAt,
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error("score insert:", e.message);
    res.status(500).json({ error: "database_error" });
  }
});

app.post("/v1/notifications", async (req, res) => {
  const b = req.body || {};
  if (!validSource(b.source) || !b.notification_id || !b.fixture_id || !Number.isFinite(Number(b.minute))) {
    return res.status(400).json({ error: "source, notification_id, fixture_id ve minute gerekli" });
  }
  const notifiedAt = asDate(b.notified_at);
  if (!notifiedAt) return res.status(400).json({ error: "notified_at geçersiz" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const context = {};
    for (const source of SOURCES) {
      if (source === b.source) {
        context[source] = { score: Number.isFinite(Number(b.score)) ? Number(b.score) : null, captured_at: notifiedAt.toISOString(), freshness: "notification_payload" };
        continue;
      }
      const q = await client.query(`
        SELECT score, minute, captured_at
        FROM algorithm_score_snapshots
        WHERE source=$1 AND fixture_id=$2 AND captured_at <= $3
        ORDER BY captured_at DESC LIMIT 1
      `, [source, String(b.fixture_id), notifiedAt]);
      const row = q.rows[0];
      if (!row) context[source] = { score: null, captured_at: null, freshness: "missing" };
      else {
        const age = notifiedAt.getTime() - new Date(row.captured_at).getTime();
        context[source] = {
          score: row.score == null ? null : Number(row.score),
          minute: row.minute,
          captured_at: new Date(row.captured_at).toISOString(),
          age_ms: age,
          freshness: age <= FRESH_MS ? "fresh" : "stale",
        };
      }
    }
    await client.query(`
      INSERT INTO algorithm_goal_notifications
        (source, notification_id, fixture_id, home, away, minute, score_at, source_score, score_context, notified_at, goal_minutes, match_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11::jsonb,$12)
      ON CONFLICT (source, notification_id) DO NOTHING
    `, [
      b.source, String(b.notification_id), String(b.fixture_id), b.home || null, b.away || null,
      Number(b.minute), JSON.stringify(b.score_at || null),
      Number.isFinite(Number(b.score)) ? Number(b.score) : null,
      JSON.stringify(context), notifiedAt, JSON.stringify(Array.isArray(b.goal_minutes) ? b.goal_minutes : []),
      b.match_status || "LIVE",
    ]);
    await client.query("COMMIT");
    res.json({ ok: true, score_context: context });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("notification insert:", e.message);
    res.status(500).json({ error: "database_error" });
  } finally { client.release(); }
});

app.post("/v1/match-state", async (req, res) => {
  const b = req.body || {};
  if (!b.fixture_id || !Array.isArray(b.goal_minutes)) {
    return res.status(400).json({ error: "fixture_id ve goal_minutes[] gerekli" });
  }
  const finished = FINISHED.has(String(b.match_status || ""));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const q = await client.query(
      "SELECT id, minute FROM algorithm_goal_notifications WHERE fixture_id=$1 AND outcome IN ('pending','window_passed') FOR UPDATE",
      [String(b.fixture_id)]
    );
    let updated = 0;
    for (const n of q.rows) {
      const result = evaluate(n, b.goal_minutes, finished);
      await client.query(`
        UPDATE algorithm_goal_notifications
        SET goal_minutes=$2::jsonb, match_status=$3, final_score=CASE WHEN $4 THEN $5::jsonb ELSE final_score END,
            outcome=$6, outcome_goal_minute=$7,
            resolved_at=CASE WHEN $8 THEN NOW() ELSE NULL END
        WHERE id=$1
      `, [
        n.id, JSON.stringify(b.goal_minutes), b.match_status || "LIVE", finished,
        JSON.stringify(b.final_score || null), result.outcome, result.goalMinute, result.resolved,
      ]);
      updated++;
    }
    await client.query("COMMIT");
    res.json({ ok: true, updated });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("match-state update:", e.message);
    res.status(500).json({ error: "database_error" });
  } finally { client.release(); }
});

app.listen(PORT, () => console.log(`Algorithm comparison collector listening on ${PORT}`));
