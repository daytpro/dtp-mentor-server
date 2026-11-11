// © Josué Morales Carmona · DayTraderProfesional (DTP)
// Valor del punto por instrumento. El AddOn envía el valor real de NinjaTrader
// (MasterInstrument.PointValue); esta tabla solo es el respaldo si no llega.

const POINT_VALUE = {
  MNQ: 2, NQ: 20, MES: 5, ES: 50, MYM: 0.5, YM: 5, M2K: 5, RTY: 50,
  MCL: 100, CL: 1000, MGC: 10, GC: 100, SIL: 1000, SI: 5000,
  M6E: 12500, "6E": 125000, MBT: 0.1, MET: 0.1,
};

/** "MNQ 12-26" → "MNQ" */
export function masterOf(instr) {
  return String(instr || "").trim().split(/\s+/)[0].toUpperCase();
}

export function pointValue(instr, sent) {
  if (Number.isFinite(sent) && sent > 0) return sent;
  return POINT_VALUE[masterOf(instr)] ?? null;
}
