// © Josué Morales Carmona · DayTraderProfesional (DTP)
//
// Protocolo v1 entre el AddOn DTP Mentor y el servidor (validación pura, sin BD).
//
// Lote (POST /v1/ingest, JSON, opcionalmente gzip):
// {
//   "v": 1,
//   "session": "<id de esta ejecución de NinjaTrader>",
//   "machine_id": "<el mismo del token de licencia>",
//   "sent_at": "2026-11-11T07:52:21.000Z",
//   "accounts": [{ "name": "...", "conn": "...", "provider": "..." }],
//   "events": [
//     { "k": "exec",  "acct", "exec_id", "order_ref", "order_id", "instr", "side": "Long|Short",
//       "qty", "price", "point_value", "time", "seq", "commission", "origin": "live|recovered|history" },
//     { "k": "order", "acct", "order_ref", "order_id", "name", "instr", "type", "action", "state",
//       "qty", "filled", "limit", "stop", "avg_fill", "time", "seq" },
//     { "k": "pnl",   "acct", "realized", "unrealized", "time" },
//     { "k": "pos",   "acct", "instr", "side": "Long|Short|Flat", "qty", "avg", "time" }
//   ]
// }
//
// Reglas:
//  · Todas las horas en UTC con zona explícita ("Z" u offset). Se rechazan horas sin zona
//    (NinjaTrader entrega Execution.Time en hora local sin zona: el AddOn la convierte).
//  · order_ref = identificador interno de NinjaTrader (Order.Id). En Rithmic el OrderId
//    cambia al aceptarlo el bróker; order_ref no.
//  · Un evento inválido se descarta y se informa; nunca rompe el lote entero.

import { parseUtc } from "./core/time.js";

export const MAX_EVENTS = 2000;
const ORIGINS = new Set(["live", "recovered", "history", "imported"]);

const str = (v, max = 200) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const optStr = (v, max = 200) => (v == null ? null : str(String(v), max));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const optNum = (v) => (v == null ? null : num(v));

export function parseBatch(body) {
  const errors = [];
  if (!body || typeof body !== "object") return { error: "bad_body" };
  if (body.v !== 1) return { error: "bad_version" };
  const session = str(body.session, 80);
  if (!session) return { error: "bad_session" };
  if (!Array.isArray(body.events)) return { error: "bad_events" };
  if (body.events.length > MAX_EVENTS) return { error: "too_many_events" };

  const accounts = [];
  for (const a of Array.isArray(body.accounts) ? body.accounts : []) {
    const name = str(a && a.name, 120);
    if (name) accounts.push({ name, conn: optStr(a.conn, 120), provider: optStr(a.provider, 60) });
  }

  const executions = [], orders = [], pnl = [], positions = [];
  body.events.forEach((e, i) => {
    const bad = (why) => errors.push({ i, why });
    if (!e || typeof e !== "object") return bad("not_object");
    const acct = str(e.acct, 120);
    if (!acct) return bad("acct");
    const time = parseUtc(e.time);
    if (time == null) return bad("time");

    switch (e.k) {
      case "exec": {
        const exec_id = str(e.exec_id, 120), instr = str(e.instr, 80);
        const qty = num(e.qty), price = num(e.price);
        if (!exec_id) return bad("exec_id");
        if (!instr) return bad("instr");
        if (e.side !== "Long" && e.side !== "Short") return bad("side");
        if (!(qty > 0) || qty > 10000) return bad("qty");
        if (price == null) return bad("price");
        const origin = ORIGINS.has(e.origin) ? e.origin : "live";
        executions.push({
          acct, exec_id, instr, side: e.side, qty, price, time,
          order_ref: optStr(e.order_ref, 120), order_id: optStr(e.order_id, 120),
          point_value: optNum(e.point_value), seq: optNum(e.seq), commission: optNum(e.commission) ?? 0,
          name: optStr(e.name, 80),           // nombre de la orden (EPO: «AGT_L», «E2L», «TP2»…); desde el AddOn 1.0.2
          origin,
        });
        return;
      }
      case "order": {
        const state = str(e.state, 40);
        if (!state) return bad("state");
        if (num(e.seq) == null) return bad("seq");   // con session, identifica el evento (reintentos sin duplicar)
        orders.push({
          acct, time, state,
          order_ref: optStr(e.order_ref, 120), order_id: optStr(e.order_id, 120),
          name: optStr(e.name, 80), instr: optStr(e.instr, 80), type: optStr(e.type, 40),
          action: optStr(e.action, 40), qty: optNum(e.qty), filled: optNum(e.filled),
          limit: optNum(e.limit), stop: optNum(e.stop), avg_fill: optNum(e.avg_fill), seq: optNum(e.seq),
        });
        return;
      }
      case "pnl":
        pnl.push({ acct, time, realized: optNum(e.realized), unrealized: optNum(e.unrealized) });
        return;
      case "pos": {
        if (!["Long", "Short", "Flat"].includes(e.side)) return bad("side");
        positions.push({ acct, time, instr: optStr(e.instr, 80), side: e.side, qty: optNum(e.qty) ?? 0, avg: optNum(e.avg) });
        return;
      }
      default:
        return bad("kind");
    }
  });

  // nombres de cuenta usados en los eventos, aunque no vengan en "accounts"
  const known = new Set(accounts.map((a) => a.name));
  for (const list of [executions, orders, pnl, positions])
    for (const e of list) if (!known.has(e.acct)) { known.add(e.acct); accounts.push({ name: e.acct, conn: null, provider: null }); }

  return { session, machine_id: optStr(body.machine_id, 128), accounts, executions, orders, pnl, positions, errors };
}

/** Quita ejecuciones repetidas dentro de un lote (mismo acct + exec_id); gana "live". */
export function dedupeExecutions(execs) {
  const m = new Map();
  for (const x of execs) {
    const k = x.acct + "\u0000" + x.exec_id;
    const prev = m.get(k);
    if (!prev || (prev.origin !== "live" && x.origin === "live")) m.set(k, { ...x, name: x.name ?? prev?.name ?? null });
    else if (!prev.name && x.name) prev.name = x.name;
  }
  return [...m.values()];
}
