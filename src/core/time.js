// © Josué Morales Carmona · DayTraderProfesional (DTP)
// Fechas y husos horarios. Todo se guarda en UTC; se convierte solo al mostrar.

const fmtCache = new Map();
function partsFmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Fecha y hora locales de un instante UTC (ms) en el huso indicado. */
export function localParts(utcMs, tz) {
  const p = {};
  for (const { type, value } of partsFmt(tz).formatToParts(new Date(utcMs))) p[type] = value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

/** Sumar días a una fecha "AAAA-MM-DD". */
export function addDays(date, n) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Día de sesión CME: la sesión empieza a las 17:00 de Nueva York.
 * Una operación del domingo o lunes 18:00 NY pertenece al día siguiente.
 */
export function tradingDay(utcMs) {
  const { date, hour } = localParts(utcMs, "America/New_York");
  return hour >= 17 ? addDays(date, 1) : date;
}

/** Acepta solo ISO 8601 con zona (Z u offset). Devuelve ms UTC o null. */
export function parseUtc(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return null;
  // Date.parse no admite más de 3 decimales en todos los motores: se recortan.
  const t = Date.parse(s.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isFinite(t) ? t : null;
}
