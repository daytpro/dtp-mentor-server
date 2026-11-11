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
  await pool.query("DROP TABLE IF EXISTS alerts, heartbeats, account_state, order_events, executions, accounts, consents, students, mentors CASCADE");
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
  assert.ok(s.json.since);                                // alumno desde
  assert.ok(s.json.mentor);                               // nombre del mentor (lo ve el alumno)
  assert.equal(s.json.groupTrades, 2);                     // único alumno con operaciones: el grupo es él
  assert.equal(s.json.groupWinRate, s.json.winRate);
  assert.equal(s.json.daysTraded, 1);
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

test("retirar pidiendo el borrado: se borran de verdad los datos; queda el registro de consentimiento", { skip }, async () => {
  const tok = await token();
  const count = async (sql) => (await pool.query(sql)).rows[0].n;
  const mine = "(SELECT id FROM accounts WHERE student_id = (SELECT id FROM students WHERE email = 'alumno@prueba.dtp'))";
  assert.ok(await count(`SELECT count(*)::int AS n FROM executions WHERE account_id IN ${mine}`) > 0);
  const r = await call("POST", "/v1/consent", { tok, body: { state: "revoked", delete_data: true } });
  assert.equal(r.json.state, "revoked");
  assert.equal(r.json.delete_requested, true);
  assert.equal(r.json.erased, true);
  assert.equal(await count(`SELECT count(*)::int AS n FROM executions WHERE account_id IN ${mine}`), 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM order_events WHERE account_id IN ${mine}`), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM accounts a JOIN students s ON s.id = a.student_id WHERE s.email = 'alumno@prueba.dtp'"), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM heartbeats h JOIN students s ON s.id = h.student_id WHERE s.email = 'alumno@prueba.dtp'"), 0);
  // el consentimiento se conserva (prueba de qué aceptó y cuándo lo retiró) y queda marcado el borrado
  assert.ok(await count("SELECT count(*)::int AS n FROM consents c JOIN students s ON s.id = c.student_id WHERE s.email = 'alumno@prueba.dtp'") >= 2);
  assert.equal(await count("SELECT count(*)::int AS n FROM consents c JOIN students s ON s.id = c.student_id WHERE s.email = 'alumno@prueba.dtp' AND c.erased_at IS NOT NULL"), 1);
  assert.equal((await call("POST", "/v1/ingest", { tok, body: batch([]) })).json.error, "no_consent");
  // retirar SIN pedir el borrado no borra nada
  const tok2 = await token({ sub: "conserva@prueba.dtp" });
  await call("POST", "/v1/consent", { tok: tok2, body: { state: "accepted", text_version: "1.0", accounts: ["SIM-C"] } });
  await call("POST", "/v1/ingest", { tok: tok2, body: batch([{ k: "exec", acct: "SIM-C", exec_id: "c1", instr: "MNQ 12-26", side: "Long", qty: 1, price: 1, time: "2026-11-11T10:00:00Z", seq: 1 }]) });
  const r2 = await call("POST", "/v1/consent", { tok: tok2, body: { state: "revoked", delete_data: false } });
  assert.equal(r2.json.erased, false);
  assert.equal(await count("SELECT count(*)::int AS n FROM executions e JOIN accounts a ON a.id = e.account_id WHERE a.name = 'SIM-C'"), 1);
});

test("nombres: el panel pone el nombre del alumno; solo con el secreto de administración", { skip }, async () => {
  assert.equal((await call("POST", "/admin/names", { body: { names: { "alumno@prueba.dtp": "Ana" } } })).status, 401);
  const r = await call("POST", "/admin/names", { admin: ADMIN, body: { names: { "ALUMNO@prueba.dtp": "Ana Pérez", "no-es-email": "X", "conserva@prueba.dtp": "" } } });
  assert.equal(r.json.changed, 1);
  const again = await call("POST", "/admin/names", { admin: ADMIN, body: { names: { "alumno@prueba.dtp": "Ana Pérez" } } });
  assert.equal(again.json.changed, 0);                    // sin cambios, no reescribe
  const { rows } = await pool.query("SELECT name FROM students WHERE email = 'alumno@prueba.dtp'");
  assert.equal(rows[0].name, "Ana Pérez");
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

test("cuadre: sin dato reciente de la cuenta o en pausa → null, nunca un falso «no coincide»", { skip }, async () => {
  const tok = await token({ sub: "cuadre@prueba.dtp" });
  await call("POST", "/v1/consent", { tok, body: { state: "accepted", text_version: "1.0", accounts: ["C1"] } });
  const ex = (id, side, price, t) => ({ k: "exec", acct: "C1", exec_id: id, instr: "MNQ 12-26", side, qty: 1, price, point_value: 2, time: t, seq: Number(id.slice(1)), origin: "live" });
  // P&L de la cuenta enviado ANTES del cierre (realizado 0) y luego las ejecuciones
  await call("POST", "/v1/ingest", { tok, body: batch([{ k: "pnl", acct: "C1", realized: 0, unrealized: 0, time: "2026-11-11T12:00:00Z" }]) });
  await new Promise((r) => setTimeout(r, 20));
  await call("POST", "/v1/ingest", { tok, body: batch([ex("e1", "Long", 100, "2026-11-11T12:01:00Z"), ex("e2", "Short", 82.5, "2026-11-11T12:02:00Z")]) });
  const get = async () => (await call("GET", "/admin/overview?day=2026-11-11", { admin: ADMIN })).json.students.find((x) => x.email === "cuadre@prueba.dtp").accounts[0];
  assert.equal((await get()).reconciled, null);           // dato viejo: no se compara
  await call("POST", "/v1/ingest", { tok, body: batch([{ k: "pnl", acct: "C1", realized: -35, unrealized: 0, time: "2026-11-11T12:02:05Z" }]) });
  assert.equal((await get()).reconciled, true);           // dato nuevo: cuadra (−17,5 × 2 = −35)
  await call("POST", "/v1/consent", { tok, body: { state: "paused", reason: "prueba de cuadre en pausa" } });
  assert.equal((await get()).reconciled, null);           // en pausa: no se compara
});

test("fase 2: reglas tras el lote, alertas guardadas, conducta en la ficha y aviso de pausa", { skip }, async () => {
  const alerts = await import("../src/alerts.js");
  const tok = await token({ sub: "reglas@prueba.dtp" });
  await call("POST", "/v1/consent", { tok, body: { state: "accepted", text_version: "1.0", accounts: ["SIM-PRUEBA", "RITHMIC-PRUEBA"] } });
  // datos reales de la sonda, sesión a sesión (cada sesión del AddOn tiene su propia numeración)
  for (const s of [1, 2]) {
    const r = await call("POST", "/v1/ingest", { tok, body: { ...batch(sondaEvents(s)), session: "sonda-" + s }, gzip: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const { rows: [st] } = await pool.query("SELECT id FROM students WHERE email = 'reglas@prueba.dtp'");
  // la sonda es del 11 nov a las 07:5x UTC: se evalúa "como si fuera" esa mañana
  await alerts.evaluateStudent(st.id, Date.parse("2026-11-11T08:10:00Z"));
  // todas las guardadas (la evaluación automática tras el lote puede haberse adelantado)
  const { rows: fresh } = await pool.query("SELECT * FROM alerts WHERE student_id = $1", [st.id]);
  const rules = fresh.map((a) => a.rule).sort();
  assert.ok(rules.includes("revenge"), rules.join(","));
  assert.ok(rules.includes("added"));
  assert.equal(rules.filter((r) => r === "stop").length, 8);   // 1 SIM + 7 RITHMIC
  assert.ok(fresh.every((a) => a.discord === "hour" || a.discord === "now"), JSON.stringify(fresh.map((a) => [a.rule, a.discord])));
  const again = await alerts.evaluateStudent(st.id, Date.parse("2026-11-11T08:10:00Z"));
  assert.equal(again.length, 0);                              // no se repiten

  const stop = fresh.find((a) => a.rule === "stop" && a.acct === "SIM-PRUEBA");
  assert.match(stop.text, /alejó 8,75 puntos \(28\.224,25 → 28\.233\) con el corto abierto/);

  const sum = await call("GET", "/admin/students/reglas@prueba.dtp/summary?from=2026-11-11&to=2026-11-11", { admin: ADMIN });
  assert.equal(sum.json.conduct.stop, 8);
  assert.equal(sum.json.conduct.revenge, 1);

  await call("POST", "/v1/consent", { tok, body: { state: "paused", reason: "Me voy al médico esta tarde" } });
  await new Promise((r) => setTimeout(r, 100));
  const list = await call("GET", "/admin/alerts?email=reglas@prueba.dtp&since=2026-11-01T00:00:00Z", { admin: ADMIN });
  const pause = list.json.alerts.find((a) => a.rule === "pause");
  assert.ok(pause);
  assert.match(pause.text, /Motivo: «Me voy al médico esta tarde»/);
  assert.equal(pause.discord, "now");
});

test("Discord: lo urgente y las pausas salen al momento; lo importante, en el resumen de la hora en punto", { skip }, async () => {
  const http = await import("node:http");
  const got = [];
  const fake = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push(JSON.parse(b)); res.writeHead(204); res.end(); }); });
  await new Promise((r) => fake.listen(0, r));
  process.env.DISCORD_WEBHOOK_URL = `http://127.0.0.1:${fake.address().port}/hook`;
  process.env.DISCORD_GAP_MS = "0";
  const alerts = await import("../src/alerts.js");
  try {
    // las 13:00 en Madrid del día de la prueba (la pausa de la prueba anterior está en "now")
    await pool.query("UPDATE alerts SET at = now() WHERE rule = 'pause'");
    for (let i = 0; i < 10; i++) await alerts.dispatch(Date.now());   // 5 por vuelta
    const pause = got.find((m) => m.content.includes("Pausó el envío"));
    assert.ok(pause, JSON.stringify(got));
    assert.equal(pause.username, "DTP Mentor");
    assert.deepEqual(pause.allowed_mentions, { parse: [] });

    await pool.query("UPDATE alerts SET at = now() WHERE discord = 'hour'");
    const before = got.length;
    await alerts.dispatch(Date.parse("2026-11-11T12:00:30Z"));        // 13:00 en Madrid
    const summary = got.slice(before);
    assert.ok(summary.some((m) => m.content.startsWith("**Resumen de la última hora")), JSON.stringify(summary));
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM alerts WHERE discord IN ('now','hour')");
    assert.equal(rows[0].n, 0);                                         // todo enviado
  } finally {
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.DISCORD_GAP_MS;
    await new Promise((r) => fake.close(r));
  }
});
