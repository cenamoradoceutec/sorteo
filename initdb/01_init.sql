-- Crear rol/DB si lo haces como superusuario (opcional):
-- CREATE USER sorteo WITH PASSWORD 'sorteopass';
-- CREATE DATABASE sorteo OWNER sorteo;
-- GRANT ALL PRIVILEGES ON DATABASE sorteo TO sorteo;

-- Tablas
CREATE TABLE IF NOT EXISTS winners (
  device_id text PRIMARY KEY,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prize_tokens (
  id serial PRIMARY KEY,
  claimed_by text NULL,
  claimed_at timestamptz NULL
);

-- Sembrar 10 tokens si está vacía
INSERT INTO prize_tokens (claimed_by, claimed_at)
SELECT NULL, NULL
FROM generate_series(1,10)
WHERE (SELECT COUNT(*) FROM prize_tokens) = 0;
