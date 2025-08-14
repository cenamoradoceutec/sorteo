import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== Config ======
const PORT = process.env.PORT || 3000;
const DEFAULT_WIN_RATE = Number(process.env.DEFAULT_WIN_RATE || 0.15);
// MAX_PRIZES es informativo: el tope real lo imponen los tokens en BD
const MAX_PRIZES = Number(process.env.MAX_PRIZES || 10);

// ====== Pool MySQL ======
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "sorteo",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ====== CORS (sin dependencias) ======
const ALLOWED_ORIGINS = [
  "http://127.0.0.1:5500", // Live Server
  "http://localhost:5500",
  "http://localhost:3000", // mismo servidor
];

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // Si usaras cookies: res.setHeader("Access-Control-Allow-Credentials","true");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}

// ====== App ======
const app = express();
app.use(corsMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ====== Helpers ======
async function getRemainingPrizes(conn) {
  const [rows] = await conn.query(
    "SELECT COUNT(*) AS remaining FROM prize_tokens WHERE claimed_by IS NULL"
  );
  return rows[0]?.remaining ?? 0;
}

async function hasWonBefore(conn, deviceId) {
  const [rows] = await conn.query(
    "SELECT 1 FROM winners WHERE device_id = ? LIMIT 1",
    [deviceId]
  );
  return rows.length > 0;
}

/**
 * Reclama un token de premio de forma atómica (garantiza el tope global):
 * UPDATE ... WHERE claimed_by IS NULL LIMIT 1
 * Si affectedRows = 1 => ganó y consumió un token.
 */
async function tryClaimPrize(conn, deviceId) {
  const [res] = await conn.query(
    "UPDATE prize_tokens SET claimed_by = ?, claimed_at = NOW() WHERE claimed_by IS NULL LIMIT 1",
    [deviceId]
  );
  return res.affectedRows === 1;
}

// ====== Endpoints ======

// Estado (útil para pruebas; quítalo si no quieres exponerlo)
app.get("/api/state", async (_req, res) => {
  const conn = await pool.getConnection();
  try {
    const remaining = await getRemainingPrizes(conn);
    const [countWinnersRows] = await conn.query(
      "SELECT COUNT(*) AS total FROM winners"
    );
    const awarded = countWinnersRows[0]?.total ?? 0;
    res.json({ ok: true, max: MAX_PRIZES, awarded, remaining });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "internal_error" });
  } finally {
    conn.release();
  }
});

// Sorteo
app.post("/api/draw", async (req, res) => {
  const { deviceId, winRate } = req.body || {};
  if (!deviceId || typeof deviceId !== "string") {
    return res
      .status(400)
      .json({ ok: false, error: "deviceId requerido" });
  }

  const rate = Number.isFinite(Number(winRate))
    ? Number(winRate)
    : DEFAULT_WIN_RATE;

  const conn = await pool.getConnection();
  try {
    // 1) Si ya ganó, no vuelve a ganar
    if (await hasWonBefore(conn, deviceId)) {
      const remaining = await getRemainingPrizes(conn);
      return res.json({
        ok: true,
        won: false,
        reason: "already_winner",
        remaining,
      });
    }

    // 2) Azar: si pierde, no tocamos BD
    const luck = Math.random() < rate;
    if (!luck) {
      const remaining = await getRemainingPrizes(conn);
      return res.json({ ok: true, won: false, remaining });
    }

    // 3) Reclamar token (atómico) para garantizar tope global
    const claimed = await tryClaimPrize(conn, deviceId);
    if (!claimed) {
      return res.json({
        ok: true,
        won: false,
        reason: "no_prizes_left",
        remaining: 0,
      });
    }

    // 4) Registrar ganador (idempotencia)
    await conn.query("INSERT IGNORE INTO winners (device_id) VALUES (?)", [
      deviceId,
    ]);

    const remaining = await getRemainingPrizes(conn);
    return res.json({ ok: true, won: true, remaining });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "internal_error" });
  } finally {
    conn.release();
  }
});

// ====== Start ======
app.listen(PORT, () => {
  console.log(`✅ Sorteo listo en http://localhost:${PORT}`);
});
