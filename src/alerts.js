// © Josué Morales Carmona · DayTraderProfesional (DTP)
//
// Alertas: se evalúan las reglas tras cada lote del AddOn, se guardan (una por hallazgo)
// y se envían a Discord.
//   · Urgentes y cambios de consentimiento (pausa, reanudar, retirar): al momento.
//   · Importantes: resumen cada hora en punto (hora de Madrid).
//   · Solo datos EN DIRECTO y de las últimas 6 h: lo histórico, recuperado o importado nunca avisa.
//   · Sin webhook configurado, las alertas se guardan igual y se ven en el panel.
//   · Nada de esto puede romper la ingesta: todo va aparte y con try/catch.
//
// Variables: DISCORD_WEBHOOK_URL (todas) y, opcional, DISCORD_WEBHOOK_URGENT (solo urgentes y consentimiento).
import * as store from "./store.js";
import { studentTrades } from "./load.js";
import { evaluate } from "./core/rules.js";
import { localParts } from "./core/time.js";
import { describe, untilText } from "./core/describe.js";

export { describe };

const DAY = 86_400_000, RECENT = 6 * 3_600_000;
const GAP = () => Number(process.env.DISCORD_GAP_MS ?? 1100);   // ritmo de Discord (en pruebas, 0)
const TZ = "Europe/Madrid";

const hhmm = (ms) => { const p = localParts(ms, TZ); return String(p.hour).padStart(2, "0") + ":" + String(p.minute).padStart(2, "0"); };
const who = (a) => a.student_name || a.email;


// ───────────────────────────────────────────── evaluación tras cada lote
const timers = new Map();

/** Evalúa las reglas del alumno unos segundos después del último lote (agrupa ráfagas). */
export function schedule(studentId, delayMs = 3000) {
  clearTimeout(timers.get(studentId));
  const t = setTimeout(() => {
    timers.delete(studentId);
    evaluateStudent(studentId).catch((e) => console.error("alertas:", e.message));
  }, delayMs);
  t.unref();
  timers.set(studentId, t);
}

export async function evaluateStudent(studentId, now = Date.now()) {
  // 35 días de ejecuciones: el tamaño habitual necesita las últimas 20 operaciones
  // 35 días de operaciones (sin cuentas maestras); las órdenes de esas operaciones también
  const { trades, open, orders } = await studentTrades(studentId, now - 35 * DAY, now + DAY);
  const findings = evaluate({ trades, open, orders }).filter((f) => f.live && f.at >= now - RECENT);
  const rows = findings.map((f) => ({
    ...f, text: describe(f), discord: f.level === "urgent" ? "now" : f.level === "info" ? "none" : "hour",
  }));
  return store.insertAlerts(studentId, rows);
}

/** Pausa, reanudación o retirada: aviso al momento. */
export async function consentChanged(student, c, erased = null) {
  let text, rule;
  if (c.state === "paused") {
    rule = "pause";
    const until = c.pause_until ? untilText(new Date(c.pause_until).getTime(), new Date(c.created_at).getTime(), TZ) : "hasta que lo reanude";
    text = `Pausó el envío ${until}. Motivo: «${c.reason}»`;
  } else if (c.state === "revoked") {
    rule = "revoke";
    text = !c.delete_requested ? "Retiró el consentimiento (conserva sus datos)."
      : erased ? `Retiró el consentimiento y pidió que se borren sus datos: borrados (${erased.executions} ejecuciones, ${erased.accounts} cuentas).`
      : "Retiró el consentimiento y pidió que se borren sus datos.";
  } else if (c.state === "accepted") {
    rule = "resume";
    text = `Envío activo. Cuentas: ${(c.accounts || []).join(", ") || "—"}`;
  } else return;
  await store.insertAlerts(student.id, [{
    key: `consent|${c.id}`, rule, level: "info", at: new Date(c.created_at).getTime(), text,
    data: { reason: c.reason || null, accounts: c.accounts || [] }, discord: "now",
  }]);
}

// ───────────────────────────────────────────── Discord
async function post(url, content) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ username: "DTP Mentor", content: content.slice(0, 1990), allowed_mentions: { parse: [] } }),
    });
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      await new Promise((ok) => setTimeout(ok, Math.min(10_000, (j.retry_after || 1) * 1000)));
      return false;
    }
    return r.ok;
  } catch { return false; } finally { clearTimeout(t); }
}

const LABEL = { urgent: "URGENTE", important: "Importante", info: "Aviso" };

function line(a) {
  return `**${who(a)}** · ${hhmm(new Date(a.at).getTime())} · ${a.text}`;
}

let busy = false, lastHourSent = null;

/** Se llama cada 5 s. Envía lo urgente y, en cada hora en punto, el resumen de lo importante. */
export async function dispatch(now = Date.now()) {
  if (busy) return;
  busy = true;
  try {
    const all = process.env.DISCORD_WEBHOOK_URL || "";
    const urgentUrl = process.env.DISCORD_WEBHOOK_URGENT || all;

    // al momento: urgentes, pausas, reanudaciones y retiradas
    const now_ = await store.alertsPending("now");
    for (const a of now_.slice(0, 5)) {
      if (!urgentUrl) { await store.markAlerts([a.id], "none"); continue; }
      if (now - new Date(a.at).getTime() > RECENT) { await store.markAlerts([a.id], "skipped"); continue; }
      const ok = await post(urgentUrl, `${LABEL[a.level] || "Aviso"} · ${line(a)}`);
      if (ok) await store.markAlerts([a.id], "sent");
      await new Promise((r) => setTimeout(r, GAP()));
    }

    // cada hora en punto (Madrid): resumen de lo importante, agrupado por alumno
    const p = localParts(now, TZ);
    const hourKey = p.date + " " + p.hour;
    if (p.minute === 0 && lastHourSent !== hourKey) {
      lastHourSent = hourKey;
      const pend = await store.alertsPending("hour");
      if (pend.length && !all) await store.markAlerts(pend.map((a) => a.id), "none");
      else if (pend.length) {
        const by = new Map();
        for (const a of pend) { const k = who(a); if (!by.has(k)) by.set(k, []); by.get(k).push(a); }
        for (const [name, list] of by) {
          const body = `**Resumen de la última hora · ${name}** (${list.length})\n` + list.map((a) => `• ${hhmm(new Date(a.at).getTime())} · ${a.text}`).join("\n");
          const ok = await post(all, body);
          if (ok) await store.markAlerts(list.map((a) => a.id), "sent");
          await new Promise((r) => setTimeout(r, GAP()));
        }
      }
    }
  } catch (e) {
    console.error("discord:", e.message);
  } finally {
    busy = false;
  }
}

export function startDispatcher() {
  const t = setInterval(() => dispatch(), 5000);
  t.unref();
  return t;
}
