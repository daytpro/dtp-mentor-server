// © Josué Morales Carmona · DayTraderProfesional (DTP)
// Texto de las alertas de conducta (sin base de datos, para poder probarlo solo).

export const money = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + " $";
export const num = (v) => Number(v).toLocaleString("es-ES", { maximumFractionDigits: 2 });
const signed = (v) => (v < 0 ? "−" : "") + num(Math.abs(v));
const sideEs = (s) => (s === "Long" ? "largo" : "corto");

/** Texto en español de un hallazgo de las reglas. */
export function describe(f) {
  const d = f.data || {};
  const where = [f.acct, f.instr ? f.instr.split(" ")[0] : null].filter(Boolean).join(" · ");
  switch (f.rule) {
    case "revenge_size": return `Revancha con exceso de contratos: entró ${d.gapSec} s después de cerrar con ${money(d.prevNet)}, con ${num(d.qty)} contratos (lo habitual en él: ${num(d.habitual)}). ${where}`;
    case "revenge": return `Revancha: entró ${d.gapSec} s después de cerrar con ${money(d.prevNet)}. ${where}`;
    case "size": return `Exceso de contratos: ${num(d.qty)} contratos; lo habitual en él son ${num(d.habitual)}. ${where}`;
    case "added": {
      if (!d.from || !d.to) return `Promedió en contra: añadió contratos al ${sideEs(d.side)} con la operación en pérdida. ${where}`;
      const loss = [d.usd != null ? money(d.usd) : null, d.points != null ? `${signed(d.points)} puntos` : null].filter(Boolean).join(", ");
      return `Promedió en contra: pasó de ${num(d.from)} a ${num(d.to)} contratos al ${sideEs(d.side)} con la operación en pérdida${loss ? ` (${loss})` : ""}. ${where}`;
    }
    case "stop": return `Stop movido en contra: lo alejó ${signed(d.points)} puntos (${num(d.from)} → ${num(d.to)}) con el ${sideEs(d.side)} abierto. ${where}`;
    case "streak": return `${d.n} pérdidas seguidas hoy (${money(d.sum)}). ${where}`;
    default: return f.rule;
  }
}
