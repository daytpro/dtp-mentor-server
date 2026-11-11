// © Josué Morales Carmona · DayTraderProfesional (DTP)
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstruct } from "../src/core/trades.js";
import { evaluate, conductCounts } from "../src/core/rules.js";
import { parseBatch, dedupeExecutions } from "../src/protocol.js";
import { sondaEvents, batch } from "./helpers.js";

function fromSonda() {
  const b = parseBatch(batch(sondaEvents()));
  const { trades, open } = reconstruct(dedupeExecutions(b.executions));
  return evaluate({ trades, open, orders: b.orders });
}

test("sonda real: stop alejado en el corto de SIM (28224,25 → 28233), una sola vez aunque haya SL2 y SL3", () => {
  const f = fromSonda().filter((x) => x.acct === "SIM-PRUEBA" && x.rule === "stop");
  assert.equal(f.length, 1);
  assert.equal(f[0].data.side, "Short");
  assert.equal(f[0].data.from, 28224.25);
  assert.equal(f[0].data.to, 28233);
  assert.equal(f[0].data.points, 8.75);
});

test("sonda real: RITHMIC — 7 veces alejó el stop del corto (los dos stops del ATM cuentan una)", () => {
  const f = fromSonda().filter((x) => x.acct === "RITHMIC-PRUEBA" && x.rule === "stop");
  assert.deepEqual(f.map((x) => x.data.to), [28223, 28226.5, 28271, 28268.5, 28253.5, 28263.75, 28283.5]);
  assert.ok(f.every((x) => x.data.side === "Short"));
});

test("sonda real: SIM — revancha (entró 24 s después de perder 49 $) y RITHMIC — promedió en contra", () => {
  const all = fromSonda();
  const rev = all.find((x) => x.acct === "SIM-PRUEBA" && x.rule === "revenge");
  assert.ok(rev);
  assert.equal(rev.data.gapSec, 25);     // 24,6 s
  assert.equal(rev.data.prevNet, -49);
  assert.ok(all.some((x) => x.acct === "RITHMIC-PRUEBA" && x.rule === "added"));
  assert.ok(all.every((x) => x.live));
});

const T0 = Date.parse("2026-11-12T14:30:00Z");
let n = 0;
const ex = (side, qty, price, sec, over = {}) => ({ acct: "A", instr: "MNQ 12-26", side, qty, price, time: T0 + sec * 1000, seq: ++n, exec_id: "e" + n, origin: "live", point_value: 2, ...over });
const round = (qty, win, startSec) => [ex("Long", qty, 100, startSec), ex("Short", qty, win ? 101 : 99, startSec + 30)];

test("exceso de contratos: más del doble de su mediana (con 5 operaciones de referencia)", () => {
  const execs = [...round(1, true, 0), ...round(1, true, 300), ...round(2, true, 600), ...round(1, true, 900), ...round(1, true, 1200), ...round(5, true, 1500)];
  const f = evaluate(reconstruct(execs));
  const s = f.filter((x) => x.rule === "size");
  assert.equal(s.length, 1);
  assert.equal(s[0].data.qty, 5);
  assert.equal(s[0].data.habitual, 1);
});

test("revancha con exceso de contratos → una sola alerta URGENTE", () => {
  const execs = [...round(1, true, 0), ...round(1, true, 300), ...round(1, true, 600), ...round(1, true, 900), ...round(1, false, 1200), ...round(4, true, 1260)];
  const f = evaluate(reconstruct(execs));
  const urgent = f.filter((x) => x.rule === "revenge_size");
  assert.equal(urgent.length, 1);
  assert.equal(urgent[0].level, "urgent");
  assert.equal(f.filter((x) => x.rule === "revenge" || x.rule === "size").length, 0);
});

test("revancha: no si pasaron 2 minutos o si la anterior fue ganadora", () => {
  assert.equal(evaluate(reconstruct([...round(1, false, 0), ...round(1, true, 150)])).filter((x) => x.rule === "revenge").length, 0);
  assert.equal(evaluate(reconstruct([...round(1, true, 0), ...round(1, true, 40)])).filter((x) => x.rule === "revenge").length, 0);
});

test("3 pérdidas seguidas en el día: un aviso", () => {
  const execs = [...round(1, false, 0), ...round(1, false, 600), ...round(1, false, 1200), ...round(1, false, 1800)];
  const s = evaluate(reconstruct(execs)).filter((x) => x.rule === "streak");
  assert.equal(s.length, 1);
  assert.equal(s[0].data.n, 3);
  assert.equal(s[0].data.sum, -6);
});

test("lo histórico se cuenta pero no es «live» (nunca avisa)", () => {
  const execs = [...round(1, false, 0), ...round(1, true, 40)].map((e) => ({ ...e, origin: "history" }));
  const f = evaluate(reconstruct(execs));
  assert.equal(f.length, 1);
  assert.equal(f[0].live, false);
  assert.deepEqual(conductCounts(f).revenge, 1);
});

test("stop de entrada movido sin posición: no cuenta", () => {
  const orders = [
    { acct: "A", instr: "MNQ 12-26", order_id: "o1", action: "Buy", stop: 110, time: T0, seq: 1 },
    { acct: "A", instr: "MNQ 12-26", order_id: "o1", action: "Buy", stop: 120, time: T0 + 5000, seq: 2 },
  ];
  assert.equal(evaluate({ trades: [], open: [], orders }).length, 0);
});
