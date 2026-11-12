// © Josué Morales Carmona · DayTraderProfesional (DTP)
import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.error("FALTA la variable DATABASE_URL. En Railway: Variables → Add Reference → Postgres → DATABASE_URL.");
  process.exit(1);
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
  max: 10,
});
pool.on("error", (e) => console.error("Postgres:", e.message));

// Migraciones idempotentes. Solo se añaden cosas; nunca se borra nada.
export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mentors (
      id          serial PRIMARY KEY,
      name        text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO mentors (id, name) VALUES (1, 'Josué Morales · DayTraderProfesional') ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS students (
      id          bigserial PRIMARY KEY,
      mentor_id   integer NOT NULL REFERENCES mentors(id) DEFAULT 1,
      email       text NOT NULL UNIQUE,
      name        text,
      status      text NOT NULL DEFAULT 'active',      -- active | archived
      created_at  timestamptz NOT NULL DEFAULT now()
    );

    -- Consentimiento RGPD: el último registro manda.
    CREATE TABLE IF NOT EXISTS consents (
      id            bigserial PRIMARY KEY,
      student_id    bigint NOT NULL REFERENCES students(id),
      text_version  text NOT NULL,
      accounts      jsonb NOT NULL DEFAULT '[]',        -- cuentas que el alumno comparte
      state         text NOT NULL,                      -- accepted | paused | revoked
      machine_id    text,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS consents_student ON consents (student_id, id DESC);
    ALTER TABLE consents ADD COLUMN IF NOT EXISTS reason text;                 -- motivo de la pausa (obligatorio)
    ALTER TABLE consents ADD COLUMN IF NOT EXISTS pause_until timestamptz;    -- null = hasta que la reanude
    ALTER TABLE consents ADD COLUMN IF NOT EXISTS delete_requested boolean NOT NULL DEFAULT false;
    ALTER TABLE consents ADD COLUMN IF NOT EXISTS erased_at timestamptz;   -- cuándo se borraron de verdad

    CREATE TABLE IF NOT EXISTS accounts (
      id          bigserial PRIMARY KEY,
      student_id  bigint NOT NULL REFERENCES students(id),
      name        text NOT NULL,
      conn        text,
      provider    text,
      first_seen  timestamptz NOT NULL DEFAULT now(),
      last_seen   timestamptz NOT NULL DEFAULT now(),
      UNIQUE (student_id, name)
    );

    CREATE TABLE IF NOT EXISTS executions (
      id           bigserial PRIMARY KEY,
      account_id   bigint NOT NULL REFERENCES accounts(id),
      exec_id      text NOT NULL,
      order_ref    text,
      order_id     text,
      instr        text NOT NULL,
      side         text NOT NULL,
      qty          double precision NOT NULL,
      price        double precision NOT NULL,
      point_value  double precision,
      time         timestamptz NOT NULL,
      seq          bigint,
      commission   double precision NOT NULL DEFAULT 0,
      origin       text NOT NULL,                       -- live | recovered | history | imported
      received_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, exec_id)
    );
    CREATE INDEX IF NOT EXISTS executions_time ON executions (account_id, time);

    CREATE TABLE IF NOT EXISTS order_events (
      id           bigserial PRIMARY KEY,
      account_id   bigint NOT NULL REFERENCES accounts(id),
      session      text NOT NULL,
      seq          bigint NOT NULL,
      order_ref    text,
      order_id     text,
      name         text,
      instr        text,
      type         text,
      action       text,
      state        text NOT NULL,
      qty          double precision,
      filled       double precision,
      limit_price  double precision,
      stop_price   double precision,
      avg_fill     double precision,
      time         timestamptz NOT NULL,
      received_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, session, seq)
    );
    CREATE INDEX IF NOT EXISTS order_events_time ON order_events (account_id, time);

    -- Estado actual de cada cuenta (lo último recibido)
    CREATE TABLE IF NOT EXISTS account_state (
      account_id   bigint PRIMARY KEY REFERENCES accounts(id),
      realized     double precision,
      unrealized   double precision,
      positions    jsonb NOT NULL DEFAULT '{}',
      updated_at   timestamptz NOT NULL DEFAULT now()
    );

    -- Alertas de conducta y de consentimiento (una por hallazgo: student_id + key)
    CREATE TABLE IF NOT EXISTS alerts (
      id            bigserial PRIMARY KEY,
      student_id    bigint NOT NULL REFERENCES students(id),
      key           text NOT NULL,
      rule          text NOT NULL,       -- revenge | size | revenge_size | added | stop | streak | pause | revoke | resume
      level         text NOT NULL,       -- urgent | important | info
      acct          text,
      instr         text,
      at            timestamptz NOT NULL,   -- cuándo pasó
      text          text NOT NULL,
      data          jsonb NOT NULL DEFAULT '{}',
      discord       text NOT NULL,        -- now | hour | none | sent | skipped
      sent_at       timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (student_id, key)
    );
    CREATE INDEX IF NOT EXISTS alerts_at ON alerts (at DESC);
    CREATE INDEX IF NOT EXISTS alerts_discord ON alerts (discord) WHERE discord IN ('now', 'hour');

    -- 0.5: nombre de la orden en cada ejecución (EPO) y cuenta maestra (la Sim que copia el Replicator)
    ALTER TABLE executions ADD COLUMN IF NOT EXISTS name text;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'normal';   -- normal | master | excluded
    CREATE INDEX IF NOT EXISTS order_events_ref ON order_events (account_id, order_ref);
    ALTER TABLE account_state ADD COLUMN IF NOT EXISTS pnl_at timestamptz;   -- cuándo dio NinjaTrader ese realizado

    CREATE TABLE IF NOT EXISTS heartbeats (
      student_id   bigint NOT NULL REFERENCES students(id),
      machine_id   text NOT NULL,
      session      text,
      app_version  text,
      queue_len    integer,
      last_seen    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (student_id, machine_id)
    );
  `);
}
