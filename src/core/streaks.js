// © Josué Morales Carmona · DayTraderProfesional (DTP)
//
// Rachas ganadoras y perdedoras, de la sesión y globales (siguen de un día a otro).
//  · Un BE (sin puntos, o resultado 0) no cuenta: ni corta la racha ni la suma.
//  · «¿Es normal?»: la racha actual comparada con su historial. Si a lo largo de su
//    historial menos del 20 % de sus rachas de ese tipo llegan a esa longitud, es poco
//    habitual; menos del 5 %, fuera de lo normal; más larga que todas, récord.
//  · «Qué pasa después»: acierto, esperanza, contratos y ratio de la operación siguiente
//    tras 1, 2 o 3+ ganadoras/perdedoras. Para decidir si subir o bajar contratos o ratio.

const round2 = (v) => Math.round(v * 100) / 100;
const isBE = (t) => t.net === 0 || (t.points != null && Math.abs(t.points) < 1e-9);
const kindOf = (t) => (t.net > 0 ? "W" : "L");

/** Operaciones cerradas en orden, sin BE. */
const sequence = (trades) =>
  trades.filter((t) => t.net != null && t.exitTime != null && !isBE(t)).sort((a, b) => a.exitTime - b.exitTime);

/** Rachas de una secuencia: [{ kind, len, net, from, to, day }]. bySession: se cortan al cambiar de día. */
export function runsOf(trades, { bySession = false } = {}) {
  const runs = [];
  let cur = null;
  for (const t of sequence(trades)) {
    const k = kindOf(t);
    if (!cur || cur.kind !== k || (bySession && cur.day !== t.day)) {
      cur = { kind: k, len: 0, net: 0, from: t.exitTime, to: t.exitTime, day: t.day };
      runs.push(cur);
    }
    cur.len++;
    cur.net += t.net;
    cur.to = t.exitTime;
  }
  return runs.map((r) => ({ ...r, net: round2(r.net) }));
}

/** ¿Es normal una racha de `len` de tipo `kind` para este alumno? */
export function normality(kind, len, historyRuns) {
  const same = historyRuns.filter((r) => r.kind === kind);
  if (same.length < 10) return { level: "few", reach: null, runs: same.length };
  const max = Math.max(...same.map((r) => r.len));
  const reach = same.filter((r) => r.len >= len).length / same.length;   // cuántas de sus rachas llegan hasta aquí
  const level = len > max ? "record" : reach < 0.05 ? "out" : reach < 0.2 ? "rare" : "normal";
  return { level, reach: round2(reach * 100), runs: same.length, max };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Máxima racha de cada tipo en cada sesión: lo típico (mediana) y lo máximo. */
function perSession(runs) {
  const byDay = new Map();
  for (const r of runs) {
    const d = byDay.get(r.day) || { W: 0, L: 0 };
    d[r.kind] = Math.max(d[r.kind], r.len);
    byDay.set(r.day, d);
  }
  const days = [...byDay.values()];
  return {
    sessions: days.length,
    W: { typical: median(days.map((d) => d.W)), max: days.length ? Math.max(...days.map((d) => d.W)) : 0 },
    L: { typical: median(days.map((d) => d.L)), max: days.length ? Math.max(...days.map((d) => d.L)) : 0 },
  };
}

/** Lo que pasa en la operación siguiente tras N ganadoras/perdedoras (secuencia global). */
function afterStreaks(trades) {
  const seq = sequence(trades);
  const keys = ["W3", "W2", "W1", "L1", "L2", "L3"];
  const g = Object.fromEntries(keys.map((k) => [k, { n: 0, wins: 0, net: 0, qty: 0, ratioSum: 0, ratioN: 0 }]));
  let kind = null, len = 0;
  for (const t of seq) {
    if (kind) {
      const k = kind + Math.min(len, 3);
      const x = g[k];
      x.n++; if (t.net > 0) x.wins++; x.net += t.net; x.qty += t.maxQty || t.qty || 0;
      if (typeof t.ratio === "number") { x.ratioSum += t.ratio; x.ratioN++; }
    }
    const k2 = kindOf(t);
    if (k2 === kind) len++; else { kind = k2; len = 1; }
  }
  const allRatio = seq.filter((t) => typeof t.ratio === "number");
  const avgRatio = allRatio.length ? allRatio.reduce((a, t) => a + t.ratio, 0) / allRatio.length : null;
  const qtys = seq.map((t) => t.maxQty || t.qty || 0).filter((q) => q > 0);
  const usualQty = median(qtys);
  return {
    usualQty,
    avgRatio: avgRatio != null ? round2(avgRatio) : null,
    rows: keys.map((k) => {
      const x = g[k];
      const r = x.ratioN ? x.ratioSum / x.ratioN : null;
      return {
        key: k, n: x.n,
        winRate: x.n ? round2((x.wins / x.n) * 100) : null,
        expectancy: x.n ? round2(x.net / x.n) : null,
        avgQty: x.n ? round2(x.qty / x.n) : null,
        moreQty: x.n && usualQty ? x.qty / x.n > usualQty * 1.2 : false,
        avgRatio: r != null ? round2(r) : null,
        // ratio frente a su media: más positivo / igual / más negativo (±10 %)
        ratioShift: r == null || avgRatio == null ? null : r > avgRatio * 1.1 + 1e-9 ? "up" : r < avgRatio * 0.9 - 1e-9 ? "down" : "same",
      };
    }),
  };
}

/**
 * Rachas para la ficha.
 * @param periodTrades operaciones cerradas del periodo (anotadas con ratio si lo hay)
 * @param historyTrades operaciones cerradas de su historial (para «¿es normal?»); incluye el periodo
 * @param today día de sesión actual (YYYY-MM-DD)
 */
export function streakSummary(periodTrades, historyTrades, today) {
  const runs = runsOf(periodTrades);
  const histRuns = runsOf(historyTrades);
  const histSessionRuns = runsOf(historyTrades, { bySession: true });
  const seqHist = sequence(historyTrades);

  // racha actual global: la última del historial
  const lastG = histRuns[histRuns.length - 1] || null;
  const current = lastG ? { kind: lastG.kind, len: lastG.len, net: lastG.net, from: lastG.from, ...normality(lastG.kind, lastG.len, histRuns) } : null;
  // racha actual de la sesión de hoy
  const lastS = histSessionRuns.filter((r) => r.day === today).pop() || null;
  const session = lastS ? { kind: lastS.kind, len: lastS.len, net: lastS.net, from: lastS.from, ...normality(lastS.kind, lastS.len, histSessionRuns) } : null;

  const best = (k) => runs.filter((r) => r.kind === k).sort((a, b) => b.len - a.len || (k === "W" ? b.net - a.net : a.net - b.net))[0] || null;
  const avgLen = (k) => {
    const xs = runs.filter((r) => r.kind === k);
    return xs.length ? round2(xs.reduce((a, r) => a + r.len, 0) / xs.length) : null;
  };
  const dist = (k) => [1, 2, 3, 4, 5].map((n) => runs.filter((r) => r.kind === k && (n === 5 ? r.len >= 5 : r.len === n)).length);

  return {
    current, session,
    last10: seqHist.slice(-10).map((t) => kindOf(t)),
    maxWin: best("W"), maxLoss: best("L"),
    avgWin: avgLen("W"), avgLoss: avgLen("L"),
    dist: { W: dist("W"), L: dist("L") },
    perSession: perSession(histSessionRuns),
    after: afterStreaks(periodTrades),
  };
}
