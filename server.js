import express from "express";
import { Pool } from "pg";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== Config ======
const PORT = process.env.PORT || 3000;
const DEFAULT_WIN_RATE = Number(process.env.DEFAULT_WIN_RATE || 0.15);
// Informativo (el tope real lo imponen los tokens en BD)
const MAX_PRIZES = Number(process.env.MAX_PRIZES || 10);

// ====== Pool Postgres ======
const pool = new Pool({
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "sorteo",
  user: process.env.PGUSER || "sorteo",
  password: process.env.PGPASSWORD || "sorteopass",
  max: 10,
  idleTimeoutMillis: 30000
});

// ====== CORS simple (opcional, quita si sirves el frontend desde el mismo origen) ======
const ALLOWED_ORIGINS = [
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://localhost:3000"
];
function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

// ====== App ======
const app = express();
app.use(cors);
app.use(express.json());
// Si pones tu index.html en ./public, descomenta esta línea:
// app.use(express.static(path.join(__dirname, "public")));

// ====== Helpers ======
async function getRemainingPrizes(client) {
  const { rows } = await client.query(
    "SELECT COUNT(*)::int AS remaining FROM prize_tokens WHERE claimed_by IS NULL"
  );
  return rows[0]?.remaining ?? 0;
}

async function hasWonBefore(client, deviceId) {
  const { rows } = await client.query(
    "SELECT 1 FROM winners WHERE device_id = $1 LIMIT 1",
    [deviceId]
  );
  return rows.length > 0;
}

/**
 * Reclama 1 token de premio de forma atómica.
 * Estrategia: CTE que selecciona 1 fila libre con FOR UPDATE SKIP LOCKED y la actualiza.
 * Si retorna una fila → premio asignado. Si no → no hay tokens libres.
 */
async function tryClaimPrize(client, deviceId) {
  const sql = `
    WITH c AS (
      SELECT id
      FROM prize_tokens
      WHERE claimed_by IS NULL
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE prize_tokens p
    SET claimed_by = $1, claimed_at = now()
    FROM c
    WHERE p.id = c.id
    RETURNING p.id;
  `;
  const { rows } = await client.query(sql, [deviceId]);
  return rows.length === 1;
}

// ====== Endpoints ======

// Estado (útil para pruebas)
app.get("/api/state", async (_req, res) => {
  const client = await pool.connect();
  try {
    const remaining = await getRemainingPrizes(client);
    const { rows } = await client.query("SELECT COUNT(*)::int AS total FROM winners");
    const awarded = rows[0]?.total ?? 0;
    res.json({ ok: true, max: MAX_PRIZES, awarded, remaining });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "internal_error" });
  } finally {
    client.release();
  }
});

// Sorteo
app.post("/api/draw", async (req, res) => {
  const { deviceId, winRate } = req.body || {};
  if (!deviceId || typeof deviceId !== "string") {
    return res.status(400).json({ ok: false, error: "deviceId requerido" });
  }

  const rate = Number.isFinite(Number(winRate)) ? Number(winRate) : DEFAULT_WIN_RATE;

  const client = await pool.connect();
  try {
    // 1) Si ya ganó, no vuelve a ganar
    if (await hasWonBefore(client, deviceId)) {
      const remaining = await getRemainingPrizes(client);
      return res.json({ ok: true, won: false, reason: "already_winner", remaining });
    }

    // 2) Azar: si pierde, no tocamos tokens
    const luck = Math.random() < rate;
    if (!luck) {
      const remaining = await getRemainingPrizes(client);
      return res.json({ ok: true, won: false, remaining });
    }

    // 3) Intento de reclamo atómico (en una transacción por claridad)
    await client.query("BEGIN");
    const claimed = await tryClaimPrize(client, deviceId);
    if (!claimed) {
      await client.query("ROLLBACK");
      return res.json({ ok: true, won: false, reason: "no_prizes_left", remaining: 0 });
    }

    // 4) Registrar ganador (idempotencia)
    await client.query(
      "INSERT INTO winners (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING",
      [deviceId]
    );
    await client.query("COMMIT");

    const remaining = await getRemainingPrizes(client);
    return res.json({ ok: true, won: true, remaining });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ ok: false, error: "internal_error" });
  } finally {
    client.release();
  }
});

// Start
app.listen(PORT, () => {
  console.log(`✅ API Sorteo (Postgres) en http://localhost:${PORT}`);
});
