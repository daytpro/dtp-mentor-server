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
  await call("POST", "/v1/consent", { tok, body: { state: "paused" } });
  assert.equal((await call("POST", "/v1/ingest", { tok, body: batch([]) })).json.error, "paused");

  await call("POST", "/v1/consent", { tok, body: { state: "accepted", text_version: "1.0", accounts: ["SIM-PRUEBA"] } });
  const ev = [{ k: "exec", acct: "REAL-NO-COMPARTIDA", exec_id: "z1", instr: "MNQ 12-26", side: "Long", qty: 1, price: 1, time: "2026-11-11T10:00:00Z", seq: 1 }];
  const r = await call("POST", "/v1/ingest", { tok, body: batch(ev) });
  assert.equal(r.json.executions, 0);
  assert.equal(r.json.skipped_not_shared, 1);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM accounts WHERE name = 'REAL-NO-COMPARTIDA'");
  assert.equal(rows[0].n, 0);
});
