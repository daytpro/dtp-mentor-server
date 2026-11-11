// © Josué Morales Carmona · DayTraderProfesional (DTP)
//
// Reglas de conducta (funciones puras). Sin plan del alumno: todas comparan al
// alumno consigo mismo o son malas en cualquier plan.
//
//   revenge       Revancha: entra menos de REVENGE_SEC después de cerrar en pérdida.
//   size          Exceso de contratos: más de SIZE_FACTOR × su tamaño habitual
//                 (mediana de sus últimas 20 operaciones; hacen falta 5).
//   revenge_size  Las dos a la vez en la misma operación → URGENTE (sustituye a las dos).
//   added         Promediar en contra: añade contratos con la operación en pérdida.
//   stop          Stop movido en contra: con posición abierta, el stop de protección
//                 se aleja (más riesgo).
//   streak        STREAK_N pérdidas seguidas en el mismo día de sesión.
//
// Cada hallazgo: { rule, level, key, acct, instr, at (ms UTC), live, data }
//   key: identifica el hallazgo para no repetir el aviso (igual con la operación abierta o cerrada).
//   live: viene de datos en directo (lo histórico/recuperado/importado nunca avisa).

export const DEFAULTS = { REVENGE_SEC: 120, SIZE_FACTOR: 2, SIZE_BASE: 20, SIZE_MIN: 5, STREAK_N: 3 };

const isLive = (origins) => Array.isArray(origins) && origins.includes("live");
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const SELL = new Set(["Sell", "SellShort"]);
const BUY = new Set(["Buy", "BuyToCover"]);

export function evaluate({ trades = [], open = [], orders = [] }, cfg = DEFAULTS) {
  const out = [];
  const byAcct = new Map();
  const items = [
    ...trades.map((t) => ({ ...t, closed: true })),
    ...open.map((t) => ({ ...t, closed: false, qty: t.maxQty ?? t.qty })),
  ].sort((a, b) => a.entryTime - b.entryTime);
  for (const t of items) {
    if (!byAcct.has(t.acct)) byAcct.set(t.acct, []);
    byAcct.get(t.acct).push(t);
  }

  for (const [acct, list] of byAcct) {
    const closed = list.filter((t) => t.closed).sort((a, b) => a.exitTime - b.exitTime);

    for (const t of list) {
      const live = isLive(t.origins);
      const base = { acct, instr: t.instr, at: t.entryTime, live };

      // revancha: la última operación cerrada antes de esta entrada, si fue pérdida y hace poco
      const prev = closed.filter((p) => p.exitTime <= t.entryTime && p !== t).at(-1);
      const gapSec = prev ? (t.entryTime - prev.exitTime) / 1000 : Infinity;
      const revenge = prev && prev.net != null && prev.net < 0 && gapSec < cfg.REVENGE_SEC;

      // tamaño frente a su propia costumbre
      const history = closed.filter((p) => p.exitTime <= t.entryTime).slice(-cfg.SIZE_BASE);
      const habitual = history.length >= cfg.SIZE_MIN ? median(history.map((p) => p.maxQty || p.qty)) : null;
      const size = habitual != null && t.qty > cfg.SIZE_FACTOR * habitual;

      const key = (r) => `${r}|${acct}|${t.entryTime}`;
      if (revenge && size) {
        out.push({ ...base, rule: "revenge_size", level: "urgent", key: key("revenge_size"),
          data: { gapSec: Math.round(gapSec), prevNet: prev.net, qty: t.qty, habitual } });
      } else {
        if (revenge) out.push({ ...base, rule: "revenge", level: "important", key: key("revenge"),
          data: { gapSec: Math.round(gapSec), prevNet: prev.net, side: t.side } });
        if (size) out.push({ ...base, rule: "size", level: "important", key: key("size"),
          data: { qty: t.qty, habitual } });
      }
      if (t.addedAgainst) out.push({ ...base, rule: "added", level: "important", key: key("added"),
        data: { side: t.side, qty: t.qty, avgEntry: t.avgEntry } });
    }

    // rachas de pérdidas por día de sesión (un aviso al llegar a N)
    const byDay = new Map();
    for (const t of closed) {
      if (t.net == null || t.net === 0) continue;
      const d = byDay.get(t.day) || { run: 0, sum: 0, done: false };
      if (t.net < 0) { d.run++; d.sum += t.net; } else { d.run = 0; d.sum = 0; }
      if (d.run >= cfg.STREAK_N && !d.done) {
        d.done = true;
        out.push({ acct, instr: t.instr, at: t.exitTime, live: isLive(t.origins), rule: "streak", level: "important",
          key: `streak|${acct}|${t.day}`, data: { n: d.run, sum: Math.round(d.sum * 100) / 100, day: t.day } });
      }
      byDay.set(t.day, d);
    }
  }

  // stop movido en contra
  const positionAt = (acct, instr, time) => {
    for (const t of byAcct.get(acct) || []) {
      if (t.instr !== instr || t.entryTime > time) continue;
      if (!t.closed || t.exitTime >= time) return t.side;
    }
    return null;
  };
  const lastStop = new Map();
  const seen = new Set();   // un ATM con varios stops iguales movidos a la vez = un solo hallazgo
  const sorted = [...orders].sort((a, b) => a.time - b.time || (a.seq ?? 0) - (b.seq ?? 0));
  for (const o of sorted) {
    if (!(o.stop > 0)) continue;
    const k = o.acct + "|" + (o.order_ref || o.order_id);
    const old = lastStop.get(k);
    lastStop.set(k, o.stop);
    if (old == null || old === o.stop) continue;
    const side = positionAt(o.acct, o.instr, o.time);
    if (!side) continue;
    const against = (side === "Long" && SELL.has(o.action) && o.stop < old) || (side === "Short" && BUY.has(o.action) && o.stop > old);
    if (!against) continue;
    const key = `stop|${o.acct}|${o.instr}|${old}|${o.stop}|${Math.floor(o.time / 2000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ acct: o.acct, instr: o.instr, at: o.time, live: true, rule: "stop", level: "important", key,
      data: { side, from: old, to: o.stop, points: Math.round(Math.abs(o.stop - old) * 100) / 100, order: o.name || null } });
  }

  return out.sort((a, b) => a.at - b.at);
}

/** Cuenta los hallazgos por regla (para la ficha del alumno). */
export function conductCounts(findings) {
  const c = { revenge: 0, size: 0, revenge_size: 0, added: 0, stop: 0, streak: 0 };
  for (const f of findings) c[f.rule] = (c[f.rule] || 0) + 1;
  return c;
}
