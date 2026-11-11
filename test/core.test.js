// © Josué Morales Carmona · DayTraderProfesional (DTP)
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstruct } from "../src/core/trades.js";
import { summarize } from "../src/core/stats.js";
import { tradingDay, parseUtc } from "../src/core/time.js";
import { parseBatch, dedupeExecutions } from "../src/protocol.js";
import { sondaEvents, sondaLines, batch } from "./helpers.js";

const T0 = Date.parse("2026-11-11T14:30:00Z");
const x = (over) => ({ acct: "A", instr: "MNQ 12-26", qty: 1, time: T0, origin: "live", ...over });
let n = 0;
const ex = (side, qty, price, dt = 0, over = {}) => x({ side, qty, price, time: T0 + dt * 1000, seq: ++n, exec_id: "e" + n, ...over });

// ─────────────────────────────────────────── datos reales (sonda, 11 nov 2026)
test("sonda real: lote válido, sin errores, duplicados quitados", () => {
  const b = parseBatch(batch(sondaEvents()));
  assert.deepEqual(b.errors, []);
  assert.equal(b.executions.length, 15);                 // 12 en directo + 3 repetidas al recompilar
  const d = dedupeExecutions(b.executions);
  assert.equal(d.length, 12);
  assert.ok(d.every((e) => e.origin === "live"));        // gana la que llegó en directo
});

test("sonda real: SIM — dos operaciones (corto −49 $, largo 0 $)", () => {
  const b = parseBatch(batch(sondaEvents()));
  const { trades, open } = reconstruct(dedupeExecutions(b.executions).filter((e) => e.acct === "SIM-PRUEBA"));
  assert.equal(open.length, 0);
  assert.equal(trades.length, 2);
  const [t1, t2] = trades;
  assert.equal(t1.side, "Short"); assert.equal(t1.qty, 2); assert.equal(t1.avgEntry, 28202.25);
  assert.equal(t1.avgExit, 28214.5); assert.equal(t1.pnl, -49); assert.equal(t1.points, -12.25);
  assert.equal(t2.side, "Long"); assert.equal(t2.qty, 2); assert.equal(t2.pnl, 0);
  assert.equal(t2.entries, 2); assert.equal(t2.exits, 2);
  assert.equal(t1.day, "2026-11-11");
});

test("sonda real: RITHMIC — sigue abierta, promedio en contra y cuadre FIFO = cuenta (−49 $)", () => {
  const b = parseBatch(batch(sondaEvents()));
  const { trades, open, fifo } = reconstruct(dedupeExecutions(b.executions).filter((e) => e.acct === "RITHMIC-PRUEBA"));
  assert.equal(trades.length, 0);
  assert.equal(open.length, 1);
  assert.equal(open[0].side, "Short"); assert.equal(open[0].qty, 3);
  assert.equal(open[0].addedAgainst, true);              // vendió a 28221,50 con el corto de 28204,75 en pérdida
  assert.deepEqual(open[0].added, { from: 1, to: 2, points: -16.75, usd: -33.5 });
  assert.equal(fifo.get("RITHMIC-PRUEBA|2026-11-11"), -49);
  // el realizado que dio la propia cuenta al final de la prueba
  const last = sondaLines().filter((l) => l.kind === "pnl" && l.acct === "RITHMIC-PRUEBA").at(-1);
  assert.equal(last.realized, -49);
});

test("sonda real: los movimientos del stop se pueden seguir por orden", () => {
  const b = parseBatch(batch(sondaEvents()));
  const sim = b.orders.filter((o) => o.acct === "SIM-PRUEBA" && o.name === "SL2");
  const first = sim[0].order_id;                         // SL2 del corto (luego hay otra SL2 en el largo)
  const stops = sim.filter((o) => o.order_id === first && o.state === "Accepted").map((o) => o.stop);
  assert.deepEqual(stops, [28227.5, 28224.25, 28233]);   // acerca, luego aleja 8,75 pts en contra
});

// ─────────────────────────────────────────── casos sintéticos
test("entradas escalonadas y salidas parciales: una sola operación", () => {
  const { trades } = reconstruct([ex("Long", 1, 100), ex("Long", 1, 102, 10), ex("Short", 1, 105, 20), ex("Short", 1, 106, 30)]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].pnl, (105 + 106 - 100 - 102) * 2);
  assert.equal(trades[0].maxQty, 2);
  assert.equal(trades[0].addedAgainst, false);           // añadió a favor
});

test("giro en una sola ejecución: cierra y abre otra", () => {
  const { trades, open } = reconstruct([ex("Long", 1, 100), ex("Short", 3, 110, 5)]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].pnl, 20);
  assert.equal(open.length, 1);
  assert.equal(open[0].side, "Short"); assert.equal(open[0].qty, 2); assert.equal(open[0].avgEntry, 110);
});

test("misma hora: el orden lo decide seq", () => {
  const a = ex("Long", 1, 100, 0), b = ex("Short", 1, 101, 0);
  const { trades } = reconstruct([b, a]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].side, "Long");
});

test("comisiones restan del neto", () => {
  const { trades } = reconstruct([ex("Long", 2, 100, 0, { commission: 1.24 }), ex("Short", 2, 101, 9, { commission: 1.24 })]);
  assert.equal(trades[0].pnl, 4);
  assert.equal(trades[0].net, 1.52);
});

test("instrumento desconocido sin valor del punto: no inventa P&L", () => {
  const { trades } = reconstruct([ex("Long", 1, 10, 0, { instr: "XYZ 12-26" }), ex("Short", 1, 11, 1, { instr: "XYZ 12-26" })]);
  assert.equal(trades[0].pnl, null);
  assert.equal(summarize(trades).unpriced, 1);
});

test("estadísticas: acierto, medias, esperanza, rachas, caída", () => {
  const mk = (net, i) => ({ net, exitTime: T0 + i, entryTime: T0 + i, day: "2026-11-11", instr: "MNQ 12-26", addedAgainst: false });
  const s = summarize([100, -50, -50, -50, 200, 0].map(mk));
  assert.equal(s.trades, 6); assert.equal(s.wins, 2); assert.equal(s.losses, 3); assert.equal(s.scratch, 1);
  assert.equal(s.winRate, 33.33); assert.equal(s.net, 150); assert.equal(s.avgWin, 150); assert.equal(s.avgLoss, -50);
  assert.equal(s.expectancy, 25); assert.equal(s.profitFactor, 2); assert.equal(s.maxLossStreak, 3);
  assert.equal(s.maxDrawdown, -150);
  assert.equal(s.byHour[0].hour, 15);                    // 14:30 UTC = 15:30 Madrid
});

test("estadísticas de la ficha: días, mejor y peor día, fechas de la caída, duración y contratos", () => {
  const mk = ([day, net, qty, min], i) => ({ net, day, qty, maxQty: qty, durationMs: min * 60_000, exitTime: T0 + i, entryTime: T0 + i, instr: "MNQ 12-26", addedAgainst: false });
  const s = summarize([["2026-11-05", 300, 2, 2], ["2026-11-06", -200, 2, 4], ["2026-11-07", -150, 5, 6], ["2026-11-07", 50, 1, 4], ["2026-11-10", 400, 2, 4]].map(mk));
  assert.equal(s.daysTraded, 4);
  assert.deepEqual(s.bestDay, { day: "2026-11-10", net: 400 });
  assert.deepEqual(s.worstDay, { day: "2026-11-06", net: -200 });
  assert.equal(s.maxDrawdown, -350);
  assert.equal(s.maxDrawdownFrom, "2026-11-05"); assert.equal(s.maxDrawdownTo, "2026-11-07");
  assert.equal(s.avgDurationMs, 4 * 60_000);
  assert.equal(s.usualQty, 2); assert.equal(s.maxQty, 5);
  const none = summarize([]);
  assert.equal(none.bestDay, null); assert.equal(none.maxDrawdownFrom, null); assert.equal(none.usualQty, null);
});

test("día de sesión CME: cambia a las 17:00 de Nueva York", () => {
  assert.equal(tradingDay(Date.parse("2026-11-11T21:59:00Z")), "2026-11-11");  // 16:59 NY
  assert.equal(tradingDay(Date.parse("2026-11-11T22:01:00Z")), "2026-11-12");  // 17:01 NY
});

test("horas sin zona: se rechazan", () => {
  assert.equal(parseUtc("2026-11-11T08:52:19.6610000"), null);
  assert.equal(parseUtc("2026-11-11T07:52:19.6610000Z"), Date.parse("2026-11-11T07:52:19.661Z"));
  const b = parseBatch(batch([{ k: "exec", acct: "A", exec_id: "1", instr: "MNQ", side: "Long", qty: 1, price: 1, time: "2026-11-11T08:52:19" }]));
  assert.equal(b.executions.length, 0);
  assert.deepEqual(b.errors, [{ i: 0, why: "time" }]);
});

test("lote mal formado: se rechaza entero sin romper", () => {
  assert.equal(parseBatch(null).error, "bad_body");
  assert.equal(parseBatch({ v: 2 }).error, "bad_version");
  assert.equal(parseBatch({ v: 1, session: "s", events: new Array(2001).fill({}) }).error, "too_many_events");
});
