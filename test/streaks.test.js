// © Josué Morales Carmona · DayTraderProfesional (DTP)
import { test } from "node:test";
import assert from "node:assert/strict";
import { runsOf, normality, streakSummary } from "../src/core/streaks.js";

let i = 0;
const tr = (day, net, extra = {}) => ({ day, net, points: net / 2, exitTime: Date.parse(`${day}T10:00:00Z`) + (i++) * 60000, qty: 1, maxQty: 1, ...extra });

test("rachas: el BE no cuenta (ni corta ni suma); globales siguen de un día a otro, las de sesión se cortan", () => {
  const t = [tr("2026-11-10", -10), tr("2026-11-10", -10), tr("2026-11-11", 0), tr("2026-11-11", -10), tr("2026-11-11", 20)];
  assert.deepEqual(runsOf(t).map((r) => `${r.kind}${r.len}`), ["L3", "W1"]);
  assert.deepEqual(runsOf(t, { bySession: true }).map((r) => `${r.kind}${r.len}`), ["L2", "L1", "W1"]);
});

test("¿es normal?: según cuántas de sus rachas llegan a esa longitud", () => {
  const hist = [...Array(16).fill({ kind: "L", len: 1 }), ...Array(3).fill({ kind: "L", len: 2 }), { kind: "L", len: 4 }];
  assert.equal(normality("L", 1, hist).level, "normal");          // 100 %
  assert.equal(normality("L", 2, hist).level, "normal");          // 20 %
  assert.equal(normality("L", 3, hist).level, "rare");            // 1 de 20 = 5 %: poco habitual
  assert.equal(normality("L", 4, [...hist, ...Array(10).fill({ kind: "L", len: 1 })]).level, "out");   // 1 de 30: fuera de lo normal
  assert.equal(normality("L", 5, hist).level, "record");
  assert.equal(normality("W", 3, hist).level, "few");             // menos de 10 rachas ganadoras: poca muestra
});

test("qué pasa después: acierto, contratos y ratio de la siguiente", () => {
  const seq = [tr("2026-11-12", -10, { maxQty: 1, ratio: 1 }), tr("2026-11-12", -10, { maxQty: 1, ratio: 1 }), tr("2026-11-12", -10, { maxQty: 3, ratio: 0.5 }),
               tr("2026-11-12", 20, { maxQty: 1, ratio: 1 })];
  const s = streakSummary(seq, seq, "2026-11-12");
  const row = (k) => s.after.rows.find((r) => r.key === k);
  assert.equal(row("L1").n, 1);
  assert.equal(row("L2").n, 1);
  assert.equal(row("L2").avgQty, 3);
  assert.equal(row("L2").moreQty, true);                          // sube contratos tras dos pérdidas
  assert.equal(row("L2").ratioShift, "down");
  assert.equal(row("L3").n, 1);
  assert.equal(row("L3").winRate, 100);
  assert.equal(s.current.kind, "W");
  assert.equal(s.session.len, 1);
  assert.deepEqual(s.last10, ["L", "L", "L", "W"]);
  assert.equal(s.maxLoss.len, 3);
  assert.equal(s.perSession.L.max, 3);
});

test("aviso: racha perdedora fuera de lo normal para ese alumno (una vez por racha)", async () => {
  const { streakFindings } = await import("../src/core/streaks.js");
  const { describe } = await import("../src/core/describe.js");
  const hist = [];
  // 12 rachas perdedoras de 1 (alternando con ganadoras) y luego 3 pérdidas seguidas en directo
  for (let k = 0; k < 12; k++) { hist.push(tr("2026-11-0" + (1 + (k % 9)), 20)); hist.push(tr("2026-11-0" + (1 + (k % 9)), -10)); }
  hist.push(tr("2026-11-12", 20));
  const live = { origins: ["live"], acct: "BX", instr: "MNQ 12-26" };
  hist.push(tr("2026-11-12", -10, live));
  assert.equal(streakFindings(hist).length, 0);              // 1 pérdida: normal
  hist.push(tr("2026-11-12", -10, live));
  const f = streakFindings(hist);
  assert.equal(f.length, 1);
  assert.equal(f[0].data.level, "record");                   // nunca había perdido 2 seguidas
  assert.equal(f[0].live, true);
  assert.match(describe(f[0]), /^Racha perdedora fuera de lo normal: 2 pérdidas seguidas/);
  hist.push(tr("2026-11-12", 15, live));
  assert.equal(streakFindings(hist).length, 0);              // la racha ya se cortó
});
