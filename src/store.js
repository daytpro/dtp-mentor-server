// © Josué Morales Carmona · DayTraderProfesional (DTP)
// Acceso a la base de datos. Todas las escrituras de un lote van en una transacción.
import { pool } from "./db.js";

export class StoreError extends Error {
  constructor(status, error, message) { super(message); this.status = status; this.error = error; }
}

export async function studentByEmail(email, db = pool) {
  const { rows: [s] } = await db.query(
    `INSERT INTO students (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING *`, [email]);
  return s;
}

export async function findStudent(email) {
  const { rows: [s] } = await pool.query("SELECT * FROM students WHERE email = $1", [String(email || "").trim().toLowerCase()]);
  return s || null;
}

export async function currentConsent(studentId, db = pool) {
  const { rows: [c] } = await db.query("SELECT * FROM consents WHERE student_id = $1 ORDER BY id DESC LIMIT 1", [studentId]);
  return c || null;
}

export async function saveConsent(studentId, { state, text_version, accounts, machine_id, reason = null, pause_until = null, delete_requested = false }) {
  // pausar o retirar conserva las cuentas y la versión del texto del último consentimiento aceptado
  if (state !== "accepted") {
    const prev = await currentConsent(studentId);
    if (prev) { accounts = prev.accounts; text_version = prev.text_version; }
  }
  const { rows: [c] } = await pool.query(
    `INSERT INTO consents (student_id, state, text_version, accounts, machine_id, reason, pause_until, delete_requested)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [studentId, state, text_version, JSON.stringify(accounts), machine_id, reason, pause_until, delete_requested]);
  return c;
}

export async function heartbeat(studentId, { machine_id, session, app_version, queue_len }) {
  await pool.query(
    `INSERT INTO heartbeats (student_id, machine_id, session, app_version, queue_len, last_seen)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (student_id, machine_id) DO UPDATE
       SET session = EXCLUDED.session, app_version = EXCLUDED.app_version,
           queue_len = EXCLUDED.queue_len, last_seen = now()`,
    [studentId, machine_id, session, app_version, queue_len]);
}

/**
 * Guarda un lote ya validado (protocol.parseBatch + dedupe).
 * Solo se guardan las cuentas que el alumno comparte en su consentimiento vigente.
 */
export async function ingest(studentId, b) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const consent = await currentConsent(studentId, client);
    if (!consent || consent.state !== "accepted") {
      await client.query("ROLLBACK");
      throw new StoreError(403, consent && consent.state === "paused" ? "paused" : "no_consent",
        consent && consent.state === "paused" ? "El envío está pausado por el alumno." : "Falta el consentimiento del alumno.");
    }
    const shared = new Set(consent.accounts || []);
    const accepted = (name) => shared.has(name);

    // cuentas
    const accIds = new Map();
    for (const a of b.accounts) {
      if (!accepted(a.name)) continue;
      const { rows: [r] } = await client.query(
        `INSERT INTO accounts (student_id, name, conn, provider) VALUES ($1,$2,$3,$4)
         ON CONFLICT (student_id, name) DO UPDATE
           SET last_seen = now(),
               conn = COALESCE(EXCLUDED.conn, accounts.conn),
               provider = COALESCE(EXCLUDED.provider, accounts.provider)
         RETURNING id`, [studentId, a.name, a.conn, a.provider]);
      accIds.set(a.name, r.id);
    }
    const idOf = (name) => accIds.get(name);
    let skipped = 0;
    const keep = (list) => list.filter((e) => (idOf(e.acct) ? true : (skipped++, false)));

    // ejecuciones: nuevas se insertan; si ya existía y ahora llega "en directo", se marca live
    const ex = keep(b.executions);
    let newExec = 0;
    if (ex.length) {
      const { rows } = await client.query(
        `INSERT INTO executions (account_id, exec_id, order_ref, order_id, instr, side, qty, price, point_value, time, seq, commission, origin)
         SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::float8[],
                              $8::float8[], $9::float8[], $10::timestamptz[], $11::bigint[], $12::float8[], $13::text[])
         ON CONFLICT (account_id, exec_id) DO UPDATE SET origin = 'live'
           WHERE executions.origin <> 'live' AND EXCLUDED.origin = 'live'
         RETURNING (xmax = 0) AS inserted`,
        [ex.map((e) => idOf(e.acct)), ex.map((e) => e.exec_id), ex.map((e) => e.order_ref), ex.map((e) => e.order_id),
         ex.map((e) => e.instr), ex.map((e) => e.side), ex.map((e) => e.qty), ex.map((e) => e.price),
         ex.map((e) => e.point_value), ex.map((e) => new Date(e.time)), ex.map((e) => e.seq),
         ex.map((e) => e.commission), ex.map((e) => e.origin)]);
      newExec = rows.filter((r) => r.inserted).length;
    }

    // eventos de órdenes (session + seq evita duplicados al reintentar)
    const od = keep(b.orders);
    let newOrders = 0;
    if (od.length) {
      const { rowCount } = await client.query(
        `INSERT INTO order_events (account_id, session, seq, order_ref, order_id, name, instr, type, action, state,
                                   qty, filled, limit_price, stop_price, avg_fill, time)
         SELECT * FROM unnest($1::bigint[], $2::text[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[],
                              $8::text[], $9::text[], $10::text[], $11::float8[], $12::float8[], $13::float8[],
                              $14::float8[], $15::float8[], $16::timestamptz[])
         ON CONFLICT (account_id, session, seq) DO NOTHING`,
        [od.map((e) => idOf(e.acct)), od.map(() => b.session), od.map((e) => e.seq), od.map((e) => e.order_ref),
         od.map((e) => e.order_id), od.map((e) => e.name), od.map((e) => e.instr), od.map((e) => e.type),
         od.map((e) => e.action), od.map((e) => e.state), od.map((e) => e.qty), od.map((e) => e.filled),
         od.map((e) => e.limit), od.map((e) => e.stop), od.map((e) => e.avg_fill), od.map((e) => new Date(e.time))]);
      newOrders = rowCount;
    }

    // estado actual: P&L y posiciones (lo más reciente de cada cuenta en este lote)
    const state = new Map();
    for (const p of keep(b.pnl)) {
      const s = state.get(p.acct) || { positions: {} };
      if (!s.pnlTime || p.time >= s.pnlTime) { s.pnlTime = p.time; s.realized = p.realized; s.unrealized = p.unrealized; }
      state.set(p.acct, s);
    }
    for (const p of keep(b.positions)) {
      const s = state.get(p.acct) || { positions: {} };
      const k = p.instr || "?";
      if (!s.positions[k] || p.time >= s.positions[k].time) s.positions[k] = { side: p.side, qty: p.qty, avg: p.avg, time: p.time };
      state.set(p.acct, s);
    }
    for (const [acct, s] of state) {
      await client.query(
        `INSERT INTO account_state (account_id, realized, unrealized, positions, updated_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (account_id) DO UPDATE SET
           realized   = COALESCE(EXCLUDED.realized, account_state.realized),
           unrealized = COALESCE(EXCLUDED.unrealized, account_state.unrealized),
           positions  = account_state.positions || EXCLUDED.positions,
           updated_at = now()`,
        [idOf(acct), s.realized ?? null, s.unrealized ?? null, JSON.stringify(s.positions)]);
    }

    await client.query("COMMIT");
    return { executions: newExec, orders: newOrders, skipped_not_shared: skipped };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Ejecuciones de un alumno en un intervalo, en el formato del núcleo. */
export async function loadExecutions(studentId, fromMs, toMs) {
  const { rows } = await pool.query(
    `SELECT a.name AS acct, e.exec_id, e.order_ref, e.order_id, e.instr, e.side, e.qty, e.price, e.point_value,
            e.time, e.seq, e.commission, e.origin
       FROM executions e JOIN accounts a ON a.id = e.account_id
      WHERE a.student_id = $1 AND e.time >= $2 AND e.time < $3
      ORDER BY e.time, e.seq`,
    [studentId, new Date(fromMs), new Date(toMs)]);
  return rows.map((r) => ({ ...r, time: r.time.getTime(), seq: r.seq == null ? null : Number(r.seq) }));
}

export async function listStudents() {
  const { rows } = await pool.query(
    `SELECT s.id, s.email, s.name, s.status, s.mentor_id,
            c.state AS consent, c.accounts AS shared_accounts, c.reason AS pause_reason, c.pause_until, c.delete_requested, c.created_at AS consent_at,
            (SELECT max(h.last_seen) FROM heartbeats h WHERE h.student_id = s.id) AS last_seen,
            (SELECT max(h.queue_len) FROM heartbeats h WHERE h.student_id = s.id AND h.last_seen > now() - interval '2 minutes') AS queue_len
       FROM students s
       LEFT JOIN LATERAL (SELECT * FROM consents c WHERE c.student_id = s.id ORDER BY c.id DESC LIMIT 1) c ON true
      WHERE s.status = 'active'
      ORDER BY s.email`);
  return rows;
}

export async function accountStates(studentId) {
  const { rows } = await pool.query(
    `SELECT a.name, a.conn, a.provider, st.realized, st.unrealized, st.positions, st.updated_at,
            (SELECT max(e.received_at) FROM executions e WHERE e.account_id = a.id) AS last_exec_at
       FROM accounts a LEFT JOIN account_state st ON st.account_id = a.id
      WHERE a.student_id = $1 ORDER BY a.name`, [studentId]);
  return rows;
}

export async function mentorName(id) {
  const { rows: [m] } = await pool.query("SELECT name FROM mentors WHERE id = $1", [id]);
  return m ? m.name : null;
}

/** Eventos de órdenes de un alumno en un intervalo, en el formato de las reglas. */
export async function loadOrders(studentId, fromMs, toMs) {
  const { rows } = await pool.query(
    `SELECT a.name AS acct, o.order_ref, o.order_id, o.name, o.instr, o.type, o.action, o.state,
            o.qty, o.filled, o.limit_price AS limit, o.stop_price AS stop, o.time, o.seq
       FROM order_events o JOIN accounts a ON a.id = o.account_id
      WHERE a.student_id = $1 AND o.time >= $2 AND o.time < $3
      ORDER BY o.time, o.seq`,
    [studentId, new Date(fromMs), new Date(toMs)]);
  return rows.map((r) => ({ ...r, time: r.time.getTime(), seq: r.seq == null ? null : Number(r.seq) }));
}

/** Guarda alertas nuevas (las repetidas se ignoran). Devuelve las que eran nuevas. */
export async function insertAlerts(studentId, list) {
  if (!list.length) return [];
  const { rows } = await pool.query(
    `INSERT INTO alerts (student_id, key, rule, level, acct, instr, at, text, data, discord)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::timestamptz[], $8::text[], $9::jsonb[], $10::text[])
     ON CONFLICT (student_id, key) DO NOTHING
     RETURNING *`,
    [studentId, list.map((a) => a.key), list.map((a) => a.rule), list.map((a) => a.level), list.map((a) => a.acct ?? null),
     list.map((a) => a.instr ?? null), list.map((a) => new Date(a.at)), list.map((a) => a.text),
     list.map((a) => JSON.stringify(a.data || {})), list.map((a) => a.discord)]);
  return rows;
}

export async function alertsPending(kind) {
  const { rows } = await pool.query(
    `SELECT al.*, s.email, s.name AS student_name FROM alerts al JOIN students s ON s.id = al.student_id
      WHERE al.discord = $1 ORDER BY al.at, al.id LIMIT 200`, [kind]);
  return rows;
}

export async function markAlerts(ids, status) {
  if (!ids.length) return;
  await pool.query(`UPDATE alerts SET discord = $2, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END WHERE id = ANY($1::bigint[])`, [ids, status]);
}

export async function listAlerts({ sinceMs, studentId = null, limit = 100 }) {
  const { rows } = await pool.query(
    `SELECT al.id, s.email, s.name AS student_name, al.rule, al.level, al.acct, al.instr, al.at, al.text, al.data,
            al.discord, al.sent_at
       FROM alerts al JOIN students s ON s.id = al.student_id
      WHERE al.at >= $1 AND ($2::bigint IS NULL OR al.student_id = $2)
      ORDER BY al.at DESC LIMIT $3`,
    [new Date(sinceMs), studentId, Math.min(Math.max(limit, 1), 500)]);
  return rows;
}
