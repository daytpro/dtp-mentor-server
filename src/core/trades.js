// © Josué Morales Carmona · DayTraderProfesional (DTP)
//
// Reconstrucción de operaciones a partir de ejecuciones.
//
//  · Una operación empieza cuando la posición sale de 0 y termina cuando las
//    EJECUCIONES la devuelven a 0 (nunca el aviso de posición: en algunas
//    conexiones NinjaTrader avisa del cambio de posición antes de entregar la
//    ejecución de salida).
//  · Un giro (de largo a corto en una sola ejecución) cierra la operación y
//    abre otra con el resto.
//  · Entradas escalonadas y salidas parciales van dentro de la misma operación.
//  · P&L bruto de la operación = Σ(ventas) − Σ(compras), por el valor del punto.
//  · Además se calcula el realizado FIFO, que es como lo cuenta NinjaTrader en
//    la cuenta: sirve para el cuadre aunque haya una posición abierta.
//
// Ejecución de entrada (ya normalizada por la ingesta):
//   { acct, instr, side: "Long"|"Short", qty, price, time (ms UTC), seq,
//     exec_id, point_value, commission, origin }

import { pointValue } from "./instruments.js";
import { tradingDay } from "./time.js";
import { isEpoName } from "./epo.js";

const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 10000) / 10000;
const EPS = 1e-9;

export function sortExecutions(execs) {
  return [...execs].sort((a, b) => a.time - b.time || (a.seq ?? 0) - (b.seq ?? 0) || String(a.exec_id).localeCompare(String(b.exec_id)));
}

function newTrade(x, dir, pv) {
  return {
    acct: x.acct, instr: x.instr, side: dir > 0 ? "Long" : "Short",
    entryTime: x.time, exitTime: null,
    pointValue: pv,
    qtyOpen: 0, maxQty: 0, entries: 0, exits: 0,
    buyQty: 0, buyValue: 0, sellQty: 0, sellValue: 0,
    entryQty: 0, entryValue: 0, exitQty: 0, exitValue: 0,
    commission: 0,
    addedAgainst: false,   // añadió contratos con la operación en pérdida
    added: null,           // la primera vez: { from, to, points, usd } (pérdida abierta en ese momento)
    origins: new Set(), execIds: [],
    entryName: null, exitName: null,   // nombre de la orden de la primera entrada y de la última salida
    entryNames: [],                    // { name, time } de cada entrada (para saber qué nivel de EPO ya entró)
  };
}

function apply(tr, x, signedQty, isEntry) {
  const q = Math.abs(signedQty);
  if (signedQty > 0) { tr.buyQty += q; tr.buyValue += q * x.price; }
  else { tr.sellQty += q; tr.sellValue += q * x.price; }
  if (isEntry) { tr.entryQty += q; tr.entryValue += q * x.price; tr.entries++; if (!tr.entryName && x.name) tr.entryName = x.name; if (x.name) tr.entryNames.push({ name: x.name, time: x.time }); }
  else { tr.exitQty += q; tr.exitValue += q * x.price; tr.exits++; if (x.name) tr.exitName = x.name; }
  tr.origins.add(x.origin || "live");
  tr.execIds.push(x.exec_id);
}

function finish(tr, x) {
  const pnlPts = tr.sellValue - tr.buyValue;          // en puntos × contratos
  const avgEntry = tr.entryValue / tr.entryQty;
  const avgExit = tr.exitValue / tr.exitQty;
  const dir = tr.side === "Long" ? 1 : -1;
  const pnl = tr.pointValue != null ? round2(pnlPts * tr.pointValue) : null;
  return {
    acct: tr.acct, instr: tr.instr, side: tr.side,
    entryTime: tr.entryTime, exitTime: x.time, durationMs: x.time - tr.entryTime,
    day: tradingDay(x.time),
    qty: tr.entryQty, maxQty: tr.maxQty, entries: tr.entries, exits: tr.exits,
    avgEntry: round4(avgEntry), avgExit: round4(avgExit),
    points: round2((avgExit - avgEntry) * dir),
    pnl, commission: round2(tr.commission),
    net: pnl != null ? round2(pnl - tr.commission) : null,
    addedAgainst: tr.addedAgainst, added: tr.added,
    origins: [...tr.origins].sort(),
    execIds: tr.execIds,
    entryName: tr.entryName, exitName: tr.exitName, entryNames: tr.entryNames,
  };
}

/**
 * @returns {{ trades: object[], open: object[], fifo: Map<string, number> }}
 *   fifo: realizado FIFO en $ por "cuenta|díaDeSesión".
 */
export function reconstruct(executions) {
  const trades = [];
  const state = new Map();     // cuenta|instrumento → { pos, tr, lots }
  const fifo = new Map();

  for (const x of sortExecutions(executions)) {
    const key = x.acct + "|" + x.instr;
    let s = state.get(key);
    if (!s) { s = { pos: 0, tr: null, lots: [] }; state.set(key, s); }
    const pv = pointValue(x.instr, x.point_value);
    let signed = (x.side === "Long" ? 1 : -1) * Math.abs(x.qty);
    const commissionPerContract = (x.commission || 0) / Math.abs(x.qty || 1);

    // ── FIFO (realizado de la cuenta)
    {
      let rest = signed;
      const fkey = x.acct + "|" + tradingDay(x.time);
      while (Math.abs(rest) > EPS && s.lots.length && Math.sign(s.lots[0].q) !== Math.sign(rest)) {
        const lot = s.lots[0];
        const take = Math.min(Math.abs(lot.q), Math.abs(rest));
        const dir = Math.sign(lot.q);
        if (pv != null) fifo.set(fkey, round2((fifo.get(fkey) || 0) + (x.price - lot.px) * dir * take * pv));
        lot.q -= dir * take;
        rest += dir * take;
        if (Math.abs(lot.q) < EPS) s.lots.shift();
      }
      if (Math.abs(rest) > EPS) s.lots.push({ q: rest, px: x.price });
    }

    // ── De plano a plano
    while (Math.abs(signed) > EPS) {
      if (s.pos === 0) {
        s.tr = newTrade(x, Math.sign(signed), pv);
      }
      const tr = s.tr;
      const sameDir = Math.sign(signed) === Math.sign(s.pos) || s.pos === 0;
      if (sameDir) {
        if (s.pos !== 0) {
          const avg = tr.entryValue / tr.entryQty;
          // los niveles de EPO (E2, E3…) entran más abajo a propósito: eso no es «promediar en contra»
          if (((s.pos > 0 && x.price < avg) || (s.pos < 0 && x.price > avg)) && !isEpoName(x.name)) {
            tr.addedAgainst = true;
            if (!tr.added) {
              const pts = (x.price - avg) * Math.sign(s.pos);
              tr.added = {
                from: Math.abs(s.pos), to: Math.abs(s.pos + signed),
                points: round2(pts),
                usd: tr.pointValue != null ? round2(pts * Math.abs(s.pos) * tr.pointValue) : null,
              };
            }
          }
        }
        apply(tr, x, signed, true);
        tr.commission += commissionPerContract * Math.abs(signed);
        s.pos += signed;
        tr.maxQty = Math.max(tr.maxQty, Math.abs(s.pos));
        signed = 0;
      } else {
        const close = Math.min(Math.abs(signed), Math.abs(s.pos)) * Math.sign(signed);
        apply(tr, x, close, false);
        tr.commission += commissionPerContract * Math.abs(close);
        s.pos += close;
        signed -= close;
        if (Math.abs(s.pos) < EPS) {
          s.pos = 0;
          trades.push(finish(tr, x));
          s.tr = null;
        }
      }
    }
  }

  const open = [];
  for (const [key, s] of state) {
    if (s.pos !== 0 && s.tr) {
      const [acct, instr] = key.split("|");
      open.push({
        acct, instr, side: s.pos > 0 ? "Long" : "Short", qty: Math.abs(s.pos),
        avgEntry: round4(s.tr.entryValue / s.tr.entryQty),
        entryTime: s.tr.entryTime, addedAgainst: s.tr.addedAgainst, added: s.tr.added,
        maxQty: s.tr.maxQty, origins: [...s.tr.origins].sort(),
        entryName: s.tr.entryName, entryNames: s.tr.entryNames,
      });
    }
  }
  return { trades, open, fifo };
}
