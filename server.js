// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg"; // PostgreSQL
const { Pool } = pkg;

// ---------------- CONFIGURACIONES ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

// Conexión PostgreSQL
const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
  database: process.env.PGDATABASE || "sorteo",
  port: process.env.PGPORT || 5432,
});

// ---------------- APP EXPRESS ----------------
const app = express();

// CORS para permitir peticiones desde otros orígenes
app.use(cors());
app.use(bodyParser.json());

// Servir archivos estáticos desde carpeta public
app.use(express.static(path.join(__dirname, "public")));

// Ruta principal para servir index.html
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------------- API ----------------
// Crear tabla si no existe
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS winners (
        id SERIAL PRIMARY KEY,
        device_id TEXT UNIQUE NOT NULL,
        won BOOLEAN NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("Tabla verificada/creada correctamente");
  } catch (err) {
    console.error("Error creando tabla:", err);
  }
})();

const MAX_PRIZES = 10;

// Ruta del sorteo
app.post("/api/draw", async (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.json({ ok: false, error: "Falta deviceId" });
  }

  try {
    // ¿Ya ganó antes este dispositivo?
    const prev = await pool.query(
      "SELECT won FROM winners WHERE device_id = $1",
      [deviceId]
    );

    if (prev.rows.length > 0) {
      return res.json({
        ok: true,
        won: prev.rows[0].won,
        remaining: MAX_PRIZES - (await countWinners()),
        reason: "already_winner",
      });
    }

    // ¿Quedan premios?
    const winnersCount = await countWinners();
    if (winnersCount >= MAX_PRIZES) {
      await pool.query(
        "INSERT INTO winners(device_id, won) VALUES($1, $2)",
        [deviceId, false]
      );
      return res.json({
        ok: true,
        won: false,
        remaining: 0,
        reason: "no_prizes_left",
      });
    }

    // Decidir aleatoriamente si gana (30% chance aquí)
    const winChance = Math.random() < 0.3;
    const won = winChance;

    await pool.query(
      "INSERT INTO winners(device_id, won) VALUES($1, $2)",
      [deviceId, won]
    );

    return res.json({
      ok: true,
      won,
      remaining: MAX_PRIZES - (await countWinners()),
    });
  } catch (err) {
    console.error("Error en sorteo:", err);
    return res.json({ ok: false, error: "Error en servidor" });
  }
});

async function countWinners() {
  const result = await pool.query("SELECT COUNT(*) FROM winners WHERE won = true");
  return parseInt(result.rows[0].count, 10);
}

// ---------------- INICIO SERVIDOR ----------------
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
