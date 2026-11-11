// © Josué Morales Carmona · DayTraderProfesional (DTP)
// Convierte el registro de la sonda (prueba real del 11 nov 2026, cuentas anonimizadas)
// en eventos del protocolo v1, como los enviará el AddOn.

import { readFileSync } from "node:fs";

const FIXTURE = new URL("./fixtures/sonda-2026-11-11.jsonl", import.meta.url);

// La sonda guardó Execution.Time tal cual lo da NinjaTrader: hora local (Madrid, UTC+1 en
// noviembre) sin zona. El AddOn real la convertirá a UTC; aquí se hace lo mismo.
function madridToUtc(s) {
  if (!s) return null;
  const [iso] = s.split("|");
  return new Date(iso.replace(/(\.\d{3})\d+$/, "$1") + "+01:00").toISOString();
}

export function sondaLines() {
  return readFileSync(FIXTURE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

// session: 1 o 2 (la sonda se recompiló a las 07:56 y su numeración volvió a empezar), o todas
export function sondaEvents(session) {
  const ev = [];
  for (const x of sondaLines()) {
    if (session && x.session !== session) continue;
    if (x.kind === "exec" || x.kind === "exec_snap0") {
      ev.push({
        k: "exec", acct: x.acct, exec_id: x.exec_id, order_id: x.order_id, instr: x.instr,
        side: x.mp, qty: x.qty, price: x.price, time: madridToUtc(x.time),
        seq: x.seq, commission: x.commission, origin: x.kind === "exec" ? "live" : "recovered",
      });
    } else if (x.kind === "order") {
      ev.push({
        k: "order", acct: x.acct, order_id: x.order_id, name: x.name, instr: x.instr, type: x.type,
        action: x.action, state: x.state, qty: x.qty, filled: x.filled, limit: x.limit, stop: x.stop,
        avg_fill: x.avg_fill, time: x.rx, seq: x.seq,   // como el AddOn: hora de llegada del evento
      });
    } else if (x.kind === "pnl") {
      ev.push({ k: "pnl", acct: x.acct, realized: x.realized, time: x.rx });
    }
  }
  return ev;
}

export function batch(events, extra = {}) {
  return { v: 1, session: "s-prueba", machine_id: "M-PRUEBA", sent_at: new Date().toISOString(), events, ...extra };
}
