// © Josué Morales Carmona · DayTraderProfesional (DTP)
// Operaciones de un alumno listas para usar: sin las cuentas maestras en los resultados y
// anotadas con EPO (origen, setup, salida) y ratio (TP/SL de la propia cuenta o de la maestra).

import { reconstruct } from "./core/trades.js";
import { annotate } from "./core/epo.js";
import * as store from "./store.js";

const DAY = 86_400_000;

/**
 * Ejecuciones y órdenes entre fromMs y toMs.
 * @returns {{ trades, open, fifo, orders, hasMaster }}
 *   trades/open: solo cuentas normales (las maestras no cuentan en resultados ni en conducta);
 *   orders: órdenes de las cuentas normales; fifo: realizado FIFO de todas (para el cuadre).
 */
export async function studentTrades(studentId, fromMs, toMs, { withOrders = true } = {}) {
  // las cuentas marcadas «No contar» (pruebas, cuentas fuera del programa) no entran en nada
  const counted = (x) => x.role !== "excluded";
  const execs = (await store.loadExecutions(studentId, fromMs, toMs)).filter(counted);
  const orders = withOrders ? (await store.loadOrders(studentId, fromMs, toMs)).filter(counted) : [];
  const isMaster = (x) => x.role === "master";
  const main = reconstruct(execs.filter((x) => !isMaster(x)));
  const master = reconstruct(execs.filter(isMaster));
  const mainOrders = orders.filter((o) => !isMaster(o));
  const masterOrders = orders.filter(isMaster);
  const masterTrades = [...master.trades, ...master.open.map((t) => ({ ...t, exitTime: null }))];
  const trades = withOrders ? annotate(main.trades, mainOrders, masterTrades, masterOrders) : main.trades;
  const open = withOrders ? annotate(main.open.map((t) => ({ ...t, exitTime: null })), mainOrders, masterTrades, masterOrders) : main.open;
  const fifo = new Map([...main.fifo, ...master.fifo]);
  const hasMaster = execs.some(isMaster) || orders.some(isMaster);
  return { trades, open, fifo, orders: mainOrders, hasMaster };
}

/** Lo mismo, por días de sesión (con margen de 2 días: una operación puede empezar antes). */
export async function tradesForDays(studentId, from, to, opts) {
  const r = await studentTrades(studentId, Date.parse(from + "T00:00:00Z") - 2 * DAY, Date.parse(to + "T00:00:00Z") + 2 * DAY, opts);
  return { ...r, trades: r.trades.filter((t) => t.day >= from && t.day <= to) };
}
