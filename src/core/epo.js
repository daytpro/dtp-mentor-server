// © Josué Morales Carmona · DayTraderProfesional (DTP)
//
// EPO: ¿la operación la abrió/cerró la estrategia EPO o el alumno a mano? ¿con qué ratio?
//
//  · EPO pone a sus órdenes nombres fijos (carriles «AGT_L», «REV2_S»…, niveles «E2L»,
//    botones «MKT_BUY», salidas «TP2», «SL3», «AGT_TP», «Exit»…). El DTP Replicator copia
//    las órdenes de la cuenta maestra con el mismo nombre, así que en la cuenta real
//    también se reconocen.
//  · Ratio = distancia al TP / distancia al SL, con el TP y el SL donde estaban al cerrar
//    la operación. Neutro = 1:1 (con un margen del 5 %). Por debajo, negativo; por encima, positivo.
//    Con el Replicator los TP/SL solo existen en la cuenta maestra (Sim): se toman de la
//    operación de la maestra que empezó a la vez (mismo instrumento y lado).

const LANE = "(AGTINV|AGT|REVINV|REV|ROTINV|ROT|FCONT|CONT|FBE|FB|MOM|ZSF|L2)";
const ENTRY_RE = new RegExp(`^(${LANE}\\d*_[LS]|E\\d+[LS]|SPE_[LS]|MKT_(BUY|SELL)|MLVE|GLE)$`, "i");
const EXIT_RE = new RegExp(
  `^(${LANE}\\d*_(TP|SL|ABORT)|(TP|SL|RSL)\\d+|Exit|PnL_Exit|PANIC_MKT|PANIC_L\\d+|REDUCE_MKT|REDUCE_L\\d+|OVF_FLAT|` +
  `MLVTP|MLVSL|MKT_TP|MKT_SL|MKT_RSL|SPE_TP|SPE_SL|SPE_ABORT|FADE_TP|FADE_SL|GLTP|GLSL)$`, "i");

export const GL_SETUP = "Golden Levels";

const SETUPS = [
  [/^AGT/i, "AG.Trend"], [/^REV/i, "Reversal"], [/^ROT/i, "BreakOut"], [/^FCONT/i, "Fade Cont."],
  [/^CONT/i, "Continuation"], [/^FBE?\d*_/i, "Falso rompimiento"], [/^MOM/i, "Momentum"],
  [/^ZSF/i, "Fade ZoneShift"], [/^L2\d*_/i, "L2"], [/^E\d+[LS]$/i, "Niveles"], [/^SPE_/i, "SPE"],
  [/^MKT_(BUY|SELL)$/i, "Botones"], [/^MLVE$/i, "MLV"], [/^GLE$/i, GL_SETUP],
];

export const isEpoEntry = (name) => !!name && ENTRY_RE.test(String(name).trim());
export const isEpoExit = (name) => !!name && EXIT_RE.test(String(name).trim());
/** Entrada que lanza EPO sola (carriles, niveles, SPE, MLV, Golden Levels: su límite se llena sola en el nivel). Los botones MKT_BUY/MKT_SELL los pulsa el alumno. */
export const isEpoAuto = (name) => isEpoEntry(name) && !/^MKT_(BUY|SELL)$/i.test(String(name).trim());
export const isEpoName = (name) => isEpoEntry(name) || isEpoExit(name);

/** Para un SL de EPO, la expresión de su entrada: «SL2» → E2L/E2S, «AGT2_SL» → AGT2_L/_S. null si no es de EPO. */
export function epoEntryOfStop(name) {
  const n = String(name || "").trim();
  let m = n.match(/^(?:R?SL)(\d+)$/i);
  if (m) return new RegExp(`^E${m[1]}[LS]$`, "i");
  m = n.match(new RegExp(`^(${LANE}\\d*)_SL$`, "i"));
  if (m) return new RegExp(`^${m[1]}_[LS]$`, "i");
  if (/^MKT_(SL|RSL)$/i.test(n)) return /^MKT_(BUY|SELL)$/i;
  if (/^SPE_SL$/i.test(n)) return /^SPE_[LS]$/i;
  if (/^MLVSL$/i.test(n)) return /^MLVE$/i;
  if (/^GLSL$/i.test(n)) return /^GLE$/i;
  return null;
}

export function setupOf(name) {
  if (!isEpoEntry(name)) return null;
  const n = String(name).trim();
  for (const [re, label] of SETUPS) if (re.test(n)) return label;
  return "EPO";
}

/** Origen de una operación: epo / manual / null (sin nombre: historial anterior a la 1.0.2). */
export function originOf(t) {
  if (!t.entryName) return { origin: null, setup: null, exitBy: null };
  const epo = isEpoEntry(t.entryName);
  let exitBy = null;
  if (t.exitName) exitBy = isEpoExit(t.exitName) || isEpoEntry(t.exitName) ? "epo" : "manual";
  return { origin: epo ? "epo" : "manual", setup: epo ? setupOf(t.entryName) : null, exitBy };
}

const SELL = new Set(["Sell", "SellShort"]);
const BUY = new Set(["Buy", "BuyToCover"]);
const DEAD = new Set(["Cancelled", "Rejected"]);
const round2 = (v) => Math.round(v * 100) / 100;
const instrRoot = (i) => String(i || "").split(" ")[0];

/**
 * TP y SL que protegían la operación al cerrarse, leídos de las órdenes de esa cuenta.
 * Orden límite en contra del lado = TP; orden stop = SL. De cada orden, su último precio
 * hasta el cierre (si se canceló antes del cierre, no cuenta). Varias órdenes: media por cantidad.
 */
export function protectionOf(t, orders) {
  const end = t.exitTime ?? Date.now();
  const exitSide = t.side === "Long" ? SELL : BUY;
  const last = new Map();
  for (const o of orders) {
    if (o.acct !== t.acct || instrRoot(o.instr) !== instrRoot(t.instr)) continue;
    if (!exitSide.has(o.action)) continue;
    if (o.time < t.entryTime - 2000 || o.time > end + 1500) continue;
    last.set(o.order_ref || o.order_id || `${o.name}|${o.time}`, o);
  }
  let tpQ = 0, tpV = 0, slQ = 0, slV = 0;
  for (const o of last.values()) {
    if (DEAD.has(o.state) && o.time < end - 500) continue;
    const q = Math.abs(o.qty || 1);
    const type = String(o.type || "");
    if (/stop/i.test(type) && o.stop > 0) { slQ += q; slV += q * o.stop; }
    else if (/limit/i.test(type) && o.limit > 0) { tpQ += q; tpV += q * o.limit; }
  }
  return { tp: tpQ ? tpV / tpQ : null, sl: slQ ? slV / slQ : null };
}

/** Margen del neutro: TP y SL a menos de un 5 % de distancia entre sí cuentan como 1:1. */
export const NEUTRAL_TOL = 0.05;

/** Ratio de una operación a partir de su TP/SL. */
export function ratioOf(t, prot) {
  const dir = t.side === "Long" ? 1 : -1;
  if (!prot || prot.sl == null) return { ratio: null, ratioClass: prot && prot.tp != null ? "nosl" : null, risk: null };
  const risk = (t.avgEntry - prot.sl) * dir;               // puntos hasta el SL
  if (!(risk > 0)) return { ratio: null, ratioClass: "be", risk: null };   // SL en break-even o en beneficio
  if (prot.tp == null) return { ratio: null, ratioClass: "runner", risk };
  const reward = (prot.tp - t.avgEntry) * dir;             // puede ser negativo: TP por debajo de la entrada
  const ratio = reward / risk;
  // neutro = 1:1 con un margen: un tick de deslizamiento en la entrada no lo convierte en positivo/negativo
  if (Math.abs(ratio - 1) <= NEUTRAL_TOL) return { ratio: 1, ratioClass: "neutral", risk };
  return { ratio: round2(ratio), ratioClass: ratio > 1 ? "positive" : "negative", risk };
}

/**
 * Añade a cada operación: origin, setup, exitBy, ratio, ratioClass, r (resultado en R).
 * masterTrades/masterOrders: operaciones y órdenes de las cuentas maestras (Sim con EPO).
 */
export function annotate(trades, orders, masterTrades = [], masterOrders = []) {
  const masterProt = masterTrades.map((m) => ({ m, prot: protectionOf(m, masterOrders) }));
  return trades.map((t) => {
    const o = originOf(t);
    let prot = protectionOf(t, orders);
    let from = "own", twinTrade = null;
    if (prot.tp == null && prot.sl == null) {
      // la operación copiada por el Replicator: la de la maestra que empezó a la vez
      const twin = masterProt
        .filter(({ m }) => m.side === t.side && instrRoot(m.instr) === instrRoot(t.instr) && Math.abs(m.entryTime - t.entryTime) <= 10000)
        .sort((a, b) => Math.abs(a.m.entryTime - t.entryTime) - Math.abs(b.m.entryTime - t.entryTime))[0];
      if (twin) { prot = twin.prot; from = "master"; twinTrade = twin.m; }
    }
    // con la maestra, el ratio se calcula sobre la entrada de la maestra (sus TP/SL son de esa entrada)
    const base = twinTrade ? { ...t, avgEntry: twinTrade.avgEntry } : t;
    const r = ratioOf(base, prot);
    const rMult = r.risk && t.points != null ? round2(t.points / r.risk) : null;
    return {
      ...t, ...o,
      tp: prot.tp != null ? round2(prot.tp) : null, sl: prot.sl != null ? round2(prot.sl) : null,
      ratio: r.ratio, ratioClass: r.ratioClass, r: t.exitTime ? rMult : null, ratioFrom: r.ratioClass ? from : null,
    };
  });
}

const grp = () => ({ trades: 0, wins: 0, net: 0, rSum: 0, rN: 0 });
const add = (g, t) => {
  g.trades++; if (t.net > 0) g.wins++; g.net += t.net || 0;
  if (t.r != null) { g.rSum += t.r; g.rN++; }
};
const out = (g) => ({
  trades: g.trades, wins: g.wins, net: round2(g.net),
  winRate: g.trades ? round2((g.wins / g.trades) * 100) : null,
  expectancy: g.trades ? round2(g.net / g.trades) : null,
  avgR: g.rN ? round2(g.rSum / g.rN) : null,
});

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const timeStats = (ms) => ms.length
  ? { n: ms.length, avgSec: Math.round(ms.reduce((a, x) => a + x, 0) / ms.length / 1000), medianSec: Math.round(median(ms) / 1000),
      minSec: Math.round(Math.min(...ms) / 1000), maxSec: Math.round(Math.max(...ms) / 1000) }
  : { n: 0, avgSec: null, medianSec: null, minSec: null, maxSec: null };

/** Nivel de Golden Levels (26 o 77) a partir de la entrada: los xx26 / xx77 de cada tramo de 100 puntos. */
export function glLevel(price) {
  if (!(price > 0)) return null;
  const m = ((price % 100) + 100) % 100;
  if (Math.abs(m - 26) <= 3) return "26";
  if (Math.abs(m - 77) <= 3) return "77";
  return null;
}

/**
 * Golden Levels: resultados, por nivel 26/77, cómo salieron (target, stop u otra) y cuánto tardan
 * desde la entrada hasta el target (y hasta el stop, para comparar). null si no hay operaciones GL.
 */
export function glSummary(closed) {
  const gl = closed.filter((t) => t.setup === GL_SETUP);
  if (!gl.length) return null;
  const all = grp(), lv = { "26": grp(), "77": grp() };
  const exits = { target: 0, stop: 0, other: 0 };
  const toT = [], toS = [];
  for (const t of gl) {
    add(all, t);
    const l = glLevel(t.avgEntry);
    if (l) add(lv[l], t);
    const x = String(t.exitName || "").toUpperCase();
    const ms = t.durationMs ?? (t.exitTime - t.entryTime);
    if (x === "GLTP") { exits.target++; if (ms >= 0) toT.push(ms); }
    else if (x === "GLSL") { exits.stop++; if (ms >= 0) toS.push(ms); }
    else exits.other++;
  }
  return { ...out(all), byLevel: { "26": out(lv["26"]), "77": out(lv["77"]) }, exits, toTarget: timeStats(toT), toStop: timeStats(toS) };
}

/** Resumen EPO del periodo (operaciones cerradas y ya anotadas). */
export function epoSummary(trades, { hasMaster = false } = {}) {
  const closed = trades.filter((t) => t.net != null);
  const byOrigin = { epo: grp(), manual: grp(), unknown: grp() };
  const exits = { epo: 0, manual: 0, unknown: 0 };
  const setups = new Map();
  const ratios = { negative: grp(), neutral: grp(), positive: grp(), be: grp(), runner: grp(), nosl: grp(), unknown: grp() };
  for (const t of closed) {
    add(byOrigin[t.origin || "unknown"], t);
    if (t.origin === "epo") {
      exits[t.exitBy || "unknown"]++;
      if (!setups.has(t.setup)) setups.set(t.setup, grp());
      add(setups.get(t.setup), t);
    }
    add(ratios[t.ratioClass || "unknown"], t);
  }
  const known = byOrigin.epo.trades + byOrigin.manual.trades;
  return {
    known, epo: byOrigin.epo.trades, manual: byOrigin.manual.trades, unknown: byOrigin.unknown.trades,
    pct: known ? round2((byOrigin.epo.trades / known) * 100) : null,
    byOrigin: { epo: out(byOrigin.epo), manual: out(byOrigin.manual) },
    exits,
    bySetup: [...setups].map(([setup, g]) => ({ setup, ...out(g) })).sort((a, b) => b.trades - a.trades),
    ratios: Object.fromEntries(Object.entries(ratios).map(([k, g]) => [k, out(g)])),
    hasMaster,
    gl: glSummary(closed),
  };
}
