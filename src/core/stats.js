// © Josué Morales Carmona · DayTraderProfesional (DTP)
// Estadísticas de un conjunto de operaciones cerradas (funciones puras).

import { localParts } from "./time.js";

const round2 = (v) => Math.round(v * 100) / 100;

export function summarize(trades, { tz = "Europe/Madrid" } = {}) {
  const valid = trades.filter((t) => t.net != null).sort((a, b) => a.exitTime - b.exitTime);
  const wins = valid.filter((t) => t.net > 0);
  const losses = valid.filter((t) => t.net < 0);
  const sum = (a) => a.reduce((s, t) => s + t.net, 0);

  const grossWin = sum(wins), grossLoss = sum(losses);
  const net = grossWin + grossLoss;

  // rachas y peor caída de la curva
  let curW = 0, curL = 0, maxW = 0, maxL = 0, eq = 0, peak = 0, maxDD = 0;
  let peakDay = valid.length ? valid[0].day : null, ddFrom = null, ddTo = null;
  const curve = [];
  for (const t of valid) {
    if (t.net > 0) { curW++; curL = 0; } else if (t.net < 0) { curL++; curW = 0; }
    maxW = Math.max(maxW, curW); maxL = Math.max(maxL, curL);
    eq += t.net;
    if (eq > peak) { peak = eq; peakDay = t.day; }
    if (eq - peak < maxDD) { maxDD = eq - peak; ddFrom = peakDay; ddTo = t.day; }
  }

  // por día de sesión (curva de capital), hora local e instrumento
  const byDay = new Map(), byHour = new Map(), byInstr = new Map();
  const bump = (m, k, t) => {
    const r = m.get(k) || { trades: 0, wins: 0, net: 0 };
    r.trades++; if (t.net > 0) r.wins++; r.net = round2(r.net + t.net);
    m.set(k, r);
  };
  for (const t of valid) {
    bump(byDay, t.day, t);
    bump(byHour, localParts(t.entryTime, tz).hour, t);
    bump(byInstr, t.instr.split(" ")[0], t);
  }
  let acc = 0;
  for (const d of [...byDay.keys()].sort()) {
    acc = round2(acc + byDay.get(d).net);
    curve.push({ day: d, net: byDay.get(d).net, cumulative: acc });
  }

  const n = valid.length;
  const days = curve.map((c) => c.net);
  const best = curve.reduce((b, c) => (b == null || c.net > b.net ? c : b), null);
  const worst = curve.reduce((w, c) => (w == null || c.net < w.net ? c : w), null);
  const qtys = valid.map((t) => t.maxQty || t.qty).filter((q) => q > 0).sort((a, b) => a - b);
  const median = qtys.length ? (qtys.length % 2 ? qtys[(qtys.length - 1) / 2] : (qtys[qtys.length / 2 - 1] + qtys[qtys.length / 2]) / 2) : null;
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    scratch: n - wins.length - losses.length,
    winRate: n ? round2((wins.length / n) * 100) : null,
    net: round2(net),
    avgWin: wins.length ? round2(grossWin / wins.length) : null,
    avgLoss: losses.length ? round2(grossLoss / losses.length) : null,
    expectancy: n ? round2(net / n) : null,
    profitFactor: grossLoss < 0 ? round2(grossWin / -grossLoss) : null,
    maxWinStreak: maxW,
    maxLossStreak: maxL,
    maxDrawdown: round2(maxDD),
    maxDrawdownFrom: maxDD < 0 ? ddFrom : null,     // día de sesión del máximo anterior
    maxDrawdownTo: maxDD < 0 ? ddTo : null,         // día de sesión del punto más bajo
    daysTraded: days.length,
    bestDay: best && best.net > 0 ? { day: best.day, net: best.net } : null,
    worstDay: worst && worst.net < 0 ? { day: worst.day, net: worst.net } : null,
    avgDurationMs: n ? Math.round(valid.reduce((a, t) => a + (t.durationMs || 0), 0) / n) : null,
    usualQty: median,                                // mediana de contratos (máximo de cada operación)
    maxQty: qtys.length ? qtys[qtys.length - 1] : null,
    addedAgainst: valid.filter((t) => t.addedAgainst).length,
    curve,
    byHour: [...byHour].sort((a, b) => a[0] - b[0]).map(([hour, r]) => ({ hour, ...r })),
    byInstrument: [...byInstr].map(([instrument, r]) => ({ instrument, ...r })).sort((a, b) => b.trades - a.trades),
    tz,
    unpriced: trades.length - n,   // operaciones sin valor del punto conocido
  };
}
