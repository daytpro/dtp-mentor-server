// © Josué Morales Carmona · DayTraderProfesional (DTP)
// Pruebas de integración: servidor real + Postgres de PRUEBAS (se vacía).
//   TEST_DATABASE_URL=postgres://usuario:clave@localhost:5432/base_de_pruebas npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { webcrypto as crypto } from "node:crypto";
import { sondaEvents, batch } from "./helpers.js";

const DB = process.env.TEST_DATABASE_URL;
const skip = !DB && "sin TEST_DATABASE_URL";

let server, base, pool, keys;
const ADMIN = "x".repeat(32);

async function token({ sub = "alumno@prueba.dtp", mid = "M-PRUEBA", lic = ["MENTOR"], exp = Date.now() / 1000 + 3600 } = {}) {
  const body = Buffer.from(JSON.stringify({ v: 1, sub, mid, lic, iat: Math.floor(Date.now() / 1000), exp: Math.floor(exp) })).toString("base64url");
  const sig = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(body))).toString("base64url");
  return `${body}.${sig}`;
}

async function call(method, path, { body, tok, mid = "M-PRUEBA", admin, gzip } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (tok) headers.Authorization = "Bearer " + tok;
  if (mid) headers["X-Machine-Id"] = mid;
  if (admin) headers["x-admin-secret"] = admin;
  let payload = body === undefined ? undefined : JSON.stringify(body);
  if (gzip && payload) { payload = zlib.gzipSync(payload); headers["Content-Encoding"] = "gzip"; }
  const r = await fetch(base + path, { method, headers, body: payload });
  return { status: r.status, json: await r.json() };
}

before(async () => {
  if (skip) return;
  keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey));
  process.env.DATABASE_URL = DB;
  process.env.LICENSE_PUBLIC_KEY = raw.toString("base64");
  process.env.MENTOR_PRODUCT_CODE = "MENTOR";
  process.env.MENTOR_ADMIN_SECRET = ADMIN;
  const db = await import("../src/db.js");
  pool = db.pool;
  await pool.query("DROP TABLE IF EXISTS heartbeats, account_state, order_events, executions, accounts, consents, students, mentors CASCADE");
  await db.migrate();
  const { createServer } = await import("../src/app.js");
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
});

test("salud", { skip }, async () => {
  const r = await call("GET", "/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test("licencia: sin token, otro producto, otro ordenador, caducada, firma falsa", { skip }, async () => {
  assert.equal((await call("POST", "/v1/ingest", { body: batch([]) })).status, 401);
  assert.equal((await call("POST", "/v1/ingest", { body: batch([]), tok: await token({ lic: ["VLC"] }) })).json.error, "no_product");
  assert.equal((await call("POST", "/v1/ingest", { body: batch([]), tok: await token(), mid: "OTRO" })).json.error, "bad_machine");
  assert.equal((await call("POST", "/v1/ingest", { body: batch([]), tok: await token({ exp: Date.now() / 1000 - 5 }) })).json.error, "expired");
  const t = await token();
  const fake = Buffer.from(JSON.stringify({ v: 1, sub: "otro@x", mid: "M-PRUEBA", lic: ["MENTOR"], exp: 9e9 })).toString("base64url") + "." + t.split(".")[1];
  assert.equal((await call("POST", "/v1/ingest", { body: batch([]), tok: fake })).json.error, "bad_token");
});

test("sin consentimiento no se guarda nada", { skip }, async () => {
  const r = await call("POST", "/v1/ingest", { body: batch(sondaEvents()), tok: await token() });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "no_consent");
});

test("consentimiento + lote real (gzip): se guarda; reenviar no duplica", { skip }, async () => {
  const tok = await token();
  const c = await call("POST", "/v1/consent", { tok, body: { state: "accepted", text_version: "1.0", accounts: ["SIM-PRUEBA", "RITHMIC-PRUEBA"] } });
  assert.equal(c.status, 200);

  const r1 = await call("POST", "/v1/ingest", { tok, body: batch(sondaEvents()), gzip: true });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  assert.equal(r1.json.executions, 12);
  assert.equal(r1.json.rejected, 0);
  assert.ok(r1.json.orders > 200);

  const r2 = await call("POST", "/v1/ingest", { tok, body: batch(sondaEvents()), gzip: true });
  assert.equal(r2.json.executions, 0);
  assert.equal(r2.json.orders, 0);
});

test("latido: devuelve las cuentas compartidas", { skip }, async () => {
  const r = await call("POST", "/v1/heartbeat", { tok: await token(), body: { session: "s-prueba", app_version: "0.1", queue_len: 0 } });
  assert.equal(r.json.consent, "accepted");
  assert.deepEqual(r.json.accounts, ["SIM-PRUEBA", "RITHMIC-PRUEBA"]);
  assert.equal(r.json.mentor, "Josué Morales · DayTraderProfesional");
});

test("ficha del alumno: operaciones y estadísticas del día", { skip }, async () => {
  const q = "?from=2026-11-11&to=2026-11-11";
  assert.equal((await call("GET", "/admin/students/alumno@prueba.dtp/summary" + q)).status, 401);
  const s = await call("GET", "/admin/students/alumno@prueba.dtp/summary" + q, { admin: ADMIN });
  assert.equal(s.status, 200);
  assert.equal(s.json.trades, 2);
  assert.equal(s.json.net, -49);
  assert.equal(s.json.open.length, 1);
  assert.equal(s.json.open[0].addedAgainst, true);
  const t = await call("GET", "/admin/students/alumno@prueba.dtp/trades" + q, { admin: ADMIN });
  assert.equal(t.json.trades.length, 2);
  assert.equal(t.json.trades[0].side, "Long");            // la más reciente primero
});

test("vista general: posición abierta y cuadre con la cuenta", { skip }, async () => {
  const o = await call("GET", "/admin/overview?day=2026-11-11", { admin: ADMIN });
  assert.equal(o.status, 200);
  const st = o.json.students.find((s) => s.email === "alumno@prueba.dtp");
  assert.equal(st.today.trades, 2);
  const rith = st.accounts.find((a) => a.name === "RITHMIC-PRUEBA");
  assert.equal(rith.realized, -49);
  assert.equal(rith.fifo_realized, -49);
  assert.equal(rith.reconciled, true);
});

test("pausa: rechaza; cuenta no compartida: se descarta", { skip }, async () => {
  const tok = await token();
  assert.equal((await call("POST", "/v1/consent", { tok, body: { state: "paused" } })).json.error, "reason_required");
  assert.equal((await call("POST", "/v1/consent", { tok, body: { state: "paused", reason: "viaje" } })).json.error, "reason_required");
  const p = await call("POST", "/v1/consent", { tok, body: { state: "paused", reason: "Me voy de viaje hasta el lunes" } });
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.accounts, ["SIM-PRUEBA", "RITHMIC-PRUEBA"]);   // conserva las cuentas
  assert.equal((await call("POST", "/v1/ingest", { tok, body: batch([]) })).json.error, "paused");
  const o = await call("GET", "/admin/students", { admin: ADMIN });
  assert.equal(o.json.students[0].pause_reason, "Me voy de viaje hasta el lunes");

  await call("POST", "/v1/consent", { tok, body: { state: "accepted", text_version: "1.0", accounts: ["SIM-PRUEBA"] } });
  const ev = [{ k: "exec", acct: "REAL-NO-COMPARTIDA", exec_id: "z1", instr: "MNQ 12-26", side: "Long", qty: 1, price: 1, time: "2026-11-11T10:00:00Z", seq: 1 }];
  const r = await call("POST", "/v1/ingest", { tok, body: batch(ev) });
  assert.equal(r.json.executions, 0);
  assert.equal(r.json.skipped_not_shared, 1);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM accounts WHERE name = 'REAL-NO-COMPARTIDA'");
  assert.equal(rows[0].n, 0);
});

test("retirar: puede pedir el borrado de los datos", { skip }, async () => {
  const tok = await token();
  const r = await call("POST", "/v1/consent", { tok, body: { state: "revoked", delete_data: true } });
  assert.equal(r.json.state, "revoked");
  assert.equal(r.json.delete_requested, true);
  assert.equal((await call("POST", "/v1/ingest", { tok, body: batch([]) })).json.error, "no_consent");
});

test("formato exacto del AddOn v1.0.0 (nulos, hora .fffZ, order_ref, pausa con fecha)", { skip }, async () => {
  const tok = await token({ sub: "addon@prueba.dtp" });
  const c = await call("POST", "/v1/consent", { tok, body: { state: "accepted", text_version: "1.0", accounts: ["Cuenta 50K"] } });
  assert.equal(c.status, 200);
  const ev = [
    { k: "exec", acct: "Cuenta 50K", exec_id: "X1", order_ref: "a1b2c3d4-1", order_id: "72994789", instr: "MNQ 12-26", side: "Short", qty: 1, price: 28204.75, point_value: 2, time: "2026-11-11T07:52:19.661Z", seq: 1, commission: 0, origin: "live" },
    { k: "exec", acct: "Cuenta 50K", exec_id: "X0", order_ref: null, order_id: "1", instr: "MNQ 12-26", side: "Long", qty: 1, price: 28000, point_value: null, time: "2026-10-01T14:00:00.000Z", seq: 2, commission: 0.62, origin: "history" },
    { k: "order", acct: "Cuenta 50K", order_ref: "a1b2c3d4-2", order_id: "698556de", name: "Stop1", instr: "MNQ 12-26", type: "StopMarket", action: "BuyToCover", state: "ChangeSubmitted", qty: 1, filled: 0, limit: 0, stop: 28223, avg_fill: 0, time: "2026-11-11T07:52:38.541Z", seq: 3 },
    { k: "pos", acct: "Cuenta 50K", instr: "MNQ 12-26", side: "Short", qty: 1, avg: 28204.75, time: "2026-11-11T07:52:20.140Z" },
    { k: "pnl", acct: "Cuenta 50K", realized: null, unrealized: -12.5, time: "2026-11-11T07:52:21.000Z" },
  ];
  const r = await call("POST", "/v1/ingest", { tok, body: { v: 1, session: "0123456789abcdef0123456789abcdef", machine_id: "M-PRUEBA", sent_at: "2026-11-11T07:52:22.000Z", events: ev } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.rejected, 0, JSON.stringify(r.json.errors));
  assert.equal(r.json.executions, 2);
  assert.equal(r.json.orders, 1);
  const p = await call("POST", "/v1/consent", { tok, body: { state: "paused", reason: "Cita médica esta tarde", pause_until: "2099-01-01T08:00:00.000Z" } });
  assert.equal(p.status, 200);
  const hb = await call("POST", "/v1/heartbeat", { tok, body: { session: "0123456789abcdef0123456789abcdef", app_version: "1.0.0", queue_len: 0 } });
  assert.equal(hb.json.consent, "paused");
  assert.equal(hb.json.reason, "Cita médica esta tarde");
});
