// © Josué Morales Carmona · DayTraderProfesional (DTP)
// EPO: nombres reales de la prueba del 12/11/2026 (EPO en Sim101 → DTP Replicator → cuenta real).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isEpoEntry, isEpoExit, setupOf, originOf, annotate, epoSummary, ratioOf } from "../src/core/epo.js";
import { reconstruct } from "../src/core/trades.js";
import { evaluate } from "../src/core/rules.js";

const T = (hhmmss) => Date.parse(`2026-11-12T${hhmmss}Z`);
const ex = (acct, name, side, qty, price, time, i) => ({
  acct, exec_id: `${acct}-${i}`, instr: "MNQ 12-26", side, qty, price, time: T(time), seq: i, point_value: 2, commission: 0, origin: "live", name,
});

test("nombres de EPO: entradas, salidas y setups", () => {
  for (const n of ["E2L", "E3S", "AGT_L", "AGTINV3_S", "REV2_L", "ZSF1_S", "FBE_L", "MOM3_S", "L2_L", "SPE_L", "MKT_BUY", "MKT_SELL", "MLVE"])
    assert.ok(isEpoEntry(n), n);
  for (const n of ["TP2", "SL3", "RSL1", "AGT_TP", "REV2_SL", "Exit", "PnL_Exit", "PANIC_MKT", "REDUCE_L2", "MKT_TP", "SPE_SL", "FADE_TP"])
    assert.ok(isEpoExit(n), n);
  for (const n of ["Entry", "Close", "Stop1", "Target1", "Buy", "", null]) assert.ok(!isEpoEntry(n), String(n));
  assert.equal(setupOf("AGTINV2_L"), "AG.Trend");
  assert.equal(setupOf("E2L"), "Niveles");
  assert.equal(setupOf("MKT_BUY"), "Botones");
  assert.equal(setupOf("ZSF2_S"), "Fade ZoneShift");
  assert.equal(setupOf("ROT_L"), "BreakOut");
  assert.deepEqual(originOf({ entryName: "Entry", exitName: "Close" }), { origin: "manual", setup: null, exitBy: "manual" });
  assert.deepEqual(originOf({ entryName: "E2L", exitName: "Close" }), { origin: "epo", setup: "Niveles", exitBy: "manual" });
  assert.deepEqual(originOf({ entryName: null }), { origin: null, setup: null, exitBy: null });
});

test("ratio: neutro 1:1 con margen del 5 %", () => {
  const t = { side: "Long", avgEntry: 100 };
  assert.deepEqual([ratioOf(t, { tp: 150.25, sl: 50 }).ratioClass, ratioOf(t, { tp: 150.25, sl: 50 }).ratio], ["neutral", 1]);   // 1 tick de más
  assert.equal(ratioOf(t, { tp: 147.75, sl: 50 }).ratioClass, "neutral");   // 0,955
  assert.equal(ratioOf(t, { tp: 153, sl: 50 }).ratioClass, "positive");     // 1,06
  assert.equal(ratioOf(t, { tp: 147, sl: 50 }).ratioClass, "negative");     // 0,94
});

test("ratio: neutro 1:1; TP por debajo de la entrada = negativo; SL en BE aparte", () => {
  const t = { side: "Long", avgEntry: 100 };
  assert.equal(ratioOf(t, { tp: 110, sl: 90 }).ratioClass, "neutral");
  assert.equal(ratioOf(t, { tp: 120, sl: 90 }).ratioClass, "positive");
  assert.equal(ratioOf(t, { tp: 105, sl: 90 }).ratioClass, "negative");
  assert.equal(ratioOf(t, { tp: 95, sl: 90 }).ratio, -0.5);
  assert.equal(ratioOf(t, { tp: 110, sl: 100 }).ratioClass, "be");
  assert.equal(ratioOf(t, { tp: null, sl: 90 }).ratioClass, "runner");
  assert.equal(ratioOf({ side: "Short", avgEntry: 100 }, { tp: 80, sl: 110 }).ratio, 2);
});

test("Replicator: la operación de la cuenta real toma el ratio de la Sim maestra (prueba real 09:03)", () => {
  // Sim101 (maestra, EPO): E2L+E3L a 28224,50 con TP3 28239,50 y SL 28199,50
  const master = reconstruct([
    ex("Sim101", "E2L", "Long", 1, 28224.5, "08:03:38", 1), ex("Sim101", "E3L", "Long", 1, 28224.5, "08:03:38", 2),
    ex("Sim101", "TP3", "Short", 1, 28239.5, "08:12:23", 3), ex("Sim101", "TP2", "Short", 1, 28236.75, "08:12:26", 4),
  ]);
  const masterOrders = [
    { acct: "Sim101", instr: "MNQ 12-26", order_ref: "tp3", name: "TP3", type: "Limit", action: "Sell", state: "Working", qty: 1, limit: 28239.5, time: T("08:03:39") },
    { acct: "Sim101", instr: "MNQ 12-26", order_ref: "tp2", name: "TP2", type: "Limit", action: "Sell", state: "Working", qty: 1, limit: 28236.5, time: T("08:03:39") },
    { acct: "Sim101", instr: "MNQ 12-26", order_ref: "sl3", name: "SL3", type: "StopMarket", action: "Sell", state: "Working", qty: 1, stop: 28199.5, time: T("08:03:39") },
    { acct: "Sim101", instr: "MNQ 12-26", order_ref: "sl2", name: "SL2", type: "StopMarket", action: "Sell", state: "Working", qty: 1, stop: 28199.5, time: T("08:03:39") },
    { acct: "Sim101", instr: "MNQ 12-26", order_ref: "sl3", name: "SL3", type: "StopMarket", action: "Sell", state: "Cancelled", qty: 1, stop: 28199.5, time: T("08:12:24") },
  ];
  // BX (real): copias a mercado con el mismo nombre
  const real = reconstruct([
    ex("BX", "E2L", "Long", 1, 28224.0, "08:03:38", 11), ex("BX", "E3L", "Long", 1, 28224.0, "08:03:38", 12),
    ex("BX", "TP3", "Short", 1, 28238.5, "08:12:23", 13), ex("BX", "TP2", "Short", 1, 28237.25, "08:12:25", 14),
  ]);
  const [t] = annotate(real.trades, [], master.trades, masterOrders);
  assert.equal(t.origin, "epo");
  assert.equal(t.setup, "Niveles");
  assert.equal(t.exitBy, "epo");
  assert.equal(t.ratioFrom, "master");
  assert.equal(t.sl, 28199.5);
  assert.equal(t.tp, 28238);                 // media de TP2 y TP3
  assert.equal(t.ratio, 0.54);               // 13,5 / 25
  assert.equal(t.ratioClass, "negative");
  assert.equal(t.r, 0.56);                   // 13,88 puntos / 25

  const s = epoSummary([t], { hasMaster: true });
  assert.equal(s.pct, 100);
  assert.equal(s.ratios.negative.trades, 1);
  assert.deepEqual(s.bySetup.map((x) => x.setup), ["Niveles"]);
});

test("los niveles de EPO no son «promediar en contra»; una entrada a mano sí avisa «fuera de EPO»", () => {
  const { trades } = reconstruct([
    ex("BX", "E1L", "Long", 1, 100, "09:00:00", 1), ex("BX", "E2L", "Long", 1, 98, "09:00:10", 2), ex("BX", "TP1", "Short", 2, 101, "09:01:00", 3),
    ex("BX", "Entry", "Long", 1, 100, "09:10:00", 4), ex("BX", "Entry", "Long", 1, 98, "09:10:10", 5), ex("BX", "Close", "Short", 2, 99, "09:11:00", 6),
  ]);
  assert.equal(trades[0].addedAgainst, false);
  assert.equal(trades[1].addedAgainst, true);
  const f = evaluate({ trades, open: [], orders: [] });
  assert.deepEqual(f.filter((x) => x.rule === "manual").map((x) => x.at), [T("09:10:00")]);
  assert.equal(f.filter((x) => x.rule === "added").length, 1);
  // quien no usa EPO nunca recibe «fuera de EPO»
  const { trades: soloManual } = reconstruct([ex("BX", "Entry", "Long", 1, 100, "09:10:00", 4), ex("BX", "Close", "Short", 1, 99, "09:11:00", 6)]);
  assert.equal(evaluate({ trades: soloManual, open: [], orders: [] }).filter((x) => x.rule === "manual").length, 0);
});

test("stop movido en contra: el SL de un nivel de EPO aún sin entrar lo mueve EPO; el de un nivel ya dentro, el alumno", () => {
  const { open } = reconstruct([ex("BX", "E1L", "Long", 1, 100, "09:00:00", 1)]);
  const o = (stop, name, t) => ({ acct: "BX", instr: "MNQ 12-26", order_ref: name, name, type: "StopMarket", action: "Sell", state: "Working", qty: 1, stop, time: T(t) });
  const stops = (orders) => evaluate({ trades: [], open, orders }).filter((x) => x.rule === "stop").length;
  assert.equal(stops([o(95, "SL2", "09:00:01"), o(90, "SL2", "09:00:30")]), 0);    // E2 pendiente: EPO lo sincroniza con el rango
  assert.equal(stops([o(95, "SL1", "09:00:01"), o(90, "SL1", "09:00:30")]), 1);    // E1 ya dentro: lo alejó el alumno
  assert.equal(stops([o(95, "Stop1", "09:00:01"), o(90, "Stop1", "09:00:30")]), 1);
});

test("Golden Levels: es EPO, nivel 26/77, salidas y tiempo hasta el target", async () => {
  const { glSummary, glLevel, epoSummary, isEpoAuto, epoEntryOfStop } = await import("../src/core/epo.js");
  assert.equal(setupOf("GLE"), "Golden Levels");
  assert.equal(isEpoAuto("GLE"), true);                        // no cuenta como revancha
  assert.ok(epoEntryOfStop("GLSL").test("GLE"));
  assert.equal(glLevel(28226.25), "26");
  assert.equal(glLevel(28177), "77");
  assert.equal(glLevel(28250), null);
  const T = Date.parse("2026-11-12T15:00:00Z");
  const gl = (entry, net, exitName, sec) => ({ ...originOf({ entryName: "GLE", exitName }), avgEntry: entry, net, exitName,
    entryTime: T, exitTime: T + sec * 1000, durationMs: sec * 1000 });
  const trades = [gl(28226, 50, "GLTP", 30), gl(28226, 40, "GLTP", 90), gl(28177, -60, "GLSL", 20), gl(28177, 10, "Close", 300),
                  { ...originOf({ entryName: "E1L", exitName: "TP1" }), net: 10, entryTime: T, exitTime: T + 1000 }];
  const s = glSummary(trades);
  assert.equal(s.trades, 4);
  assert.equal(s.byLevel["26"].trades, 2);
  assert.equal(s.byLevel["77"].net, -50);
  assert.deepEqual(s.exits, { target: 2, stop: 1, other: 1 });
  assert.deepEqual(s.toTarget, { n: 2, avgSec: 60, medianSec: 60, minSec: 30, maxSec: 90 });
  assert.equal(s.toStop.medianSec, 20);
  assert.equal(epoSummary(trades).bySetup.find((x) => x.setup === "Golden Levels").trades, 4);
  assert.equal(glSummary(trades.slice(4)), null);
});
