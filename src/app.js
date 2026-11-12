// © Josué Morales Carmona · DayTraderProfesional (DTP)
//
//  AddOn (Authorization: Bearer <token de licencia DTP> + X-Machine-Id):
//    POST /v1/consent     { state: accepted|paused|revoked, text_version, accounts: [nombres],
//                           reason (obligatorio al pausar), pause_until (UTC, opcional), delete_data (al retirar) }
//    POST /v1/heartbeat   { session, app_version, queue_len }
//    POST /v1/ingest      lote del protocolo v1 (src/protocol.js), JSON o gzip
//  Base44 (cabecera x-admin-secret):
//    GET  /admin/students
//    GET  /admin/overview?day=AAAA-MM-DD&tz=Europe/Madrid
//    GET  /admin/students/<email>/summary?from=AAAA-MM-DD&to=AAAA-MM-DD&tz=Europe/Madrid
//    GET  /admin/students/<email>/trades?from=AAAA-MM-DD&to=AAAA-MM-DD
//    GET  /admin/alerts?since=ISO&email=&limit=
//    POST /admin/account-role { email, account, role: normal|master|excluded }  (maestra de EPO / no contar)
//    POST /admin/names    { names: { email: nombre } }  (nombre del alumno para Discord)
//  Salud:  GET /health
import http from "node:http";
import zlib from "node:zlib";
import { pool } from "./db.js";
import { verifyLicense, isAdmin, AuthError } from "./auth.js";
import { parseBatch, dedupeExecutions } from "./protocol.js";
import { tradesForDays } from "./load.js";
import { epoSummary } from "./core/epo.js";
import { summarize } from "./core/stats.js";
import { tradingDay, addDays, parseUtc } from "./core/time.js";
import * as store from "./store.js";
import * as alerts from "./alerts.js";
import { evaluate, conductCounts } from "./core/rules.js";

const MAX_RAW = 2_000_000, MAX_JSON = 8_000_000;
const DAY = 86_400_000;

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

class HttpError extends Error {
  constructor(status, error, message) { super(message || error); this.status = status; this.error = error; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > MAX_RAW) { reject(new HttpError(413, "too_large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      let buf = Buffer.concat(chunks);
      try {
        if (String(req.headers["content-encoding"] || "").toLowerCase() === "gzip") buf = zlib.gunzipSync(buf, { maxOutputLength: MAX_JSON });
        resolve(buf.length ? JSON.parse(buf.toString("utf8")) : {});
      } catch { reject(new HttpError(400, "bad_json", "JSON no válido")); }
    });
    req.on("error", () => reject(new HttpError(400, "bad_body")));
  });
}

async function addonAuth(req) {
  const h = String(req.headers.authorization || "");
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const lic = await verifyLicense(token, String(req.headers["x-machine-id"] || "").trim());
  const student = await store.studentByEmail(lic.email);
  if (student.status !== "active") throw new HttpError(403, "archived", "Alumno dado de baja.");
  return { lic, student };
}

const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const validTz = (tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { return "Europe/Madrid"; } };

/** Operaciones cerradas cuyo día de sesión está en [from, to], y posiciones abiertas al final. */
const tradesFor = tradesForDays;

async function overview(day, tz) {
  const students = await store.listStudents();
  const out = [];
  for (const s of students) {
    const { trades, open, fifo } = await tradesFor(s.id, day, day);
    const accounts = await store.accountStates(s.id);
    const sharedNow = new Set(Array.isArray(s.shared_accounts) ? s.shared_accounts : []);
    const stats = summarize(trades, { tz });
    const todayAlerts = await store.listAlerts({ sinceMs: Date.now() - DAY, studentId: s.id, limit: 50 });
    out.push({
      email: s.email, name: s.name, consent: s.consent, pause_reason: s.pause_reason, pause_until: s.pause_until, last_seen: s.last_seen, queue_len: s.queue_len,
      today: { trades: stats.trades, net: stats.net, winRate: stats.winRate, addedAgainst: stats.addedAgainst,
               alerts: todayAlerts.filter((a) => a.level !== "info").length, urgent: todayAlerts.filter((a) => a.level === "urgent").length },
      open,
      accounts: accounts.map((a) => {
        // Cuadre: realizado de la cuenta frente al realizado FIFO de las ejecuciones recibidas.
        // Solo se compara con un dato de la cuenta POSTERIOR a la última ejecución recibida y con el
        // alumno enviando; si no, el realizado puede ser de antes del cierre (p. ej. pausó justo después).
        const fifoR = fifo.get(a.name + "|" + day) || 0;
        // y solo con cuentas que sigue compartiendo y un dato de la cuenta del mismo día de sesión
        // (de una cuenta que ya no comparte, el último dato es de otro día: daría un falso «no coincide»)
        const shared = sharedNow.has(a.name);
        const fresh = a.realized != null && s.consent === "accepted" && shared &&
          (a.pnl_at || a.updated_at) && tradingDay(new Date(a.pnl_at || a.updated_at).getTime()) === day &&
          (!a.last_exec_at || new Date(a.updated_at) >= new Date(a.last_exec_at));
        return {
          name: a.name, conn: a.conn, provider: a.provider, role: a.role || "normal", shared, realized: a.realized, unrealized: a.unrealized, updated_at: a.updated_at,
          reconciled: fresh ? Math.abs(fifoR - a.realized) < 0.01 : null,   // null = sin dato reciente
          fifo_realized: fifoR,
        };
      }),
    });
  }
  return { day, tz, students: out, alerts: await store.listAlerts({ sinceMs: Date.now() - DAY, limit: 30 }) };
}

export async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/health" || path === "/")) {
    await pool.query("SELECT 1");
    return send(res, 200, { ok: true, service: "dtp-mentor-server", version: "0.5.1" });
  }

  // ───────────────────────────── AddOn
  if (path.startsWith("/v1/")) {
    if (req.method !== "POST") throw new HttpError(405, "method");
    const { lic, student } = await addonAuth(req);
    const body = await readBody(req);

    if (path === "/v1/consent") {
      const state = body.state;
      if (!["accepted", "paused", "revoked"].includes(state)) throw new HttpError(400, "bad_state");
      const text_version = String(body.text_version || "").slice(0, 40);
      if (state === "accepted" && !text_version) throw new HttpError(400, "bad_text_version");
      const accounts = Array.isArray(body.accounts) ? body.accounts.filter((a) => typeof a === "string" && a.length <= 120).slice(0, 50) : [];
      if (state === "accepted" && !accounts.length) throw new HttpError(400, "no_accounts", "Elige al menos una cuenta.");
      // Pausar exige motivo (lo lee el mentor). Retirar permite pedir el borrado de los datos.
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 280) : "";
      if (state === "paused" && reason.length < 10) throw new HttpError(400, "reason_required", "Escribe el motivo de la pausa (mín. 10 caracteres).");
      let pause_until = null;
      if (state === "paused" && body.pause_until != null) {
        const t = parseUtc(body.pause_until);
        if (t == null || t <= Date.now()) throw new HttpError(400, "bad_pause_until");
        pause_until = new Date(t);
      }
      const c = await store.saveConsent(student.id, {
        state, text_version: text_version || "-", accounts, machine_id: lic.machineId,
        reason: reason || null, pause_until, delete_requested: state === "revoked" && body.delete_data === true,
      });
      // retirar pidiendo el borrado: se borra de verdad, al momento
      let erased = null;
      if (c.delete_requested) erased = await store.eraseStudentData(student.id, c.id);
      alerts.consentChanged(student, c, erased).catch((e) => console.error("alertas:", e.message));
      return send(res, 200, { ok: true, state: c.state, accounts: c.accounts, reason: c.reason, pause_until: c.pause_until, delete_requested: c.delete_requested, erased: !!erased });
    }

    if (path === "/v1/heartbeat") {
      await store.heartbeat(student.id, {
        machine_id: lic.machineId, session: String(body.session || "").slice(0, 80) || null,
        app_version: String(body.app_version || "").slice(0, 40) || null,
        queue_len: Number.isInteger(body.queue_len) ? body.queue_len : null,
      });
      const c = await store.currentConsent(student.id);
      const mentor = await store.mentorName(student.mentor_id);
      // el AddOn usa esto para saber qué cuentas enviar, si está pausado y a quién envía
      return send(res, 200, {
        ok: true, consent: c ? c.state : null, accounts: c ? c.accounts : [],
        reason: c ? c.reason : null, pause_until: c ? c.pause_until : null, mentor,
      });
    }

    if (path === "/v1/ingest") {
      const b = parseBatch(body);
      if (b.error) throw new HttpError(400, b.error);
      b.executions = dedupeExecutions(b.executions);
      const r = await store.ingest(student.id, b);
      if (r.executions > 0 || r.orders > 0) alerts.schedule(student.id);   // reglas aparte: nunca frenan la ingesta
      return send(res, 200, { ok: true, ...r, rejected: b.errors.length, errors: b.errors.slice(0, 20) });
    }
    throw new HttpError(404, "not_found");
  }

  // ───────────────────────────── Base44
  if (path.startsWith("/admin/")) {
    if (!isAdmin(req)) throw new HttpError(401, "unauthorized");

    // única escritura del panel: el nombre de cada alumno, para Discord
    if (path === "/admin/names") {
      if (req.method !== "POST") throw new HttpError(405, "method");
      const body = await readBody(req);
      const map = {};
      for (const [email, name] of Object.entries(body && typeof body.names === "object" && body.names ? body.names : {}).slice(0, 200)) {
        if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) continue;
        if (typeof name !== "string" || !name.trim() || name.length > 120) continue;
        map[email.trim()] = name.trim();
      }
      return send(res, 200, { ok: true, changed: await store.setNames(map) });
    }
    // cuenta maestra: la Sim donde corre EPO y que copia el Replicator (no cuenta en resultados)
    if (path === "/admin/account-role") {
      if (req.method !== "POST") throw new HttpError(405, "method");
      const body = await readBody(req);
      const email = typeof body?.email === "string" ? body.email.trim() : "";
      const account = typeof body?.account === "string" ? body.account.trim() : "";
      const role = ["normal", "master", "excluded"].includes(body?.role) ? body.role : null;
      if (!email || !account || account.length > 120 || !role) throw new HttpError(400, "bad_params");
      const changed = await store.setAccountRole(email, account, role);
      if (!changed) throw new HttpError(404, "no_account");
      const student = await store.findStudent(email);
      if (student) alerts.schedule(student.id);
      return send(res, 200, { ok: true, email, account, role });
    }
    if (req.method !== "GET") throw new HttpError(405, "method");
    const tz = validTz(url.searchParams.get("tz") || "Europe/Madrid");

    if (path === "/admin/students") return send(res, 200, { students: await store.listStudents() });

    if (path === "/admin/alerts") {
      const email = url.searchParams.get("email");
      const student = email ? await store.findStudent(email) : null;
      if (email && !student) throw new HttpError(404, "no_student");
      const since = Date.parse(url.searchParams.get("since") || "") || Date.now() - DAY;
      const limit = Number(url.searchParams.get("limit")) || 100;
      return send(res, 200, { alerts: await store.listAlerts({ sinceMs: since, studentId: student ? student.id : null, limit }) });
    }

    if (path === "/admin/overview") {
      const day = isDay(url.searchParams.get("day")) ? url.searchParams.get("day") : tradingDay(Date.now());
      return send(res, 200, await overview(day, tz));
    }

    const m = path.match(/^\/admin\/students\/([^/]+)\/(summary|trades)$/);
    if (m) {
      const student = await store.findStudent(decodeURIComponent(m[1]));
      if (!student) throw new HttpError(404, "no_student");
      const to = isDay(url.searchParams.get("to")) ? url.searchParams.get("to") : tradingDay(Date.now());
      const from = isDay(url.searchParams.get("from")) ? url.searchParams.get("from") : addDays(to, -29);
      if (from > to || Date.parse(to) - Date.parse(from) > 400 * DAY) throw new HttpError(400, "bad_range");
      const { trades, open, orders, hasMaster } = await tradesFor(student.id, from, to);
      if (m[2] === "trades") return send(res, 200, { email: student.email, from, to, trades: [...trades].reverse(), open });
      // conducta del periodo (incluye lo histórico; los stops solo existen desde que hay AddOn)
      const findings = evaluate({ trades, open, orders }).filter((f) => { const d = tradingDay(f.at); return d >= from && d <= to; });
      // acierto del grupo en el mismo periodo (para comparar)
      let gw = 0, gn = 0;
      for (const o of await store.listStudents()) {
        const r = o.id === student.id ? { trades } : await tradesFor(o.id, from, to, { withOrders: false });
        for (const t of r.trades) if (t.net != null) { gn++; if (t.net > 0) gw++; }
      }
      return send(res, 200, {
        email: student.email, from, to, ...summarize(trades, { tz }), open, conduct: conductCounts(findings),
        epo: epoSummary(trades, { hasMaster }),
        since: student.created_at, mentor: await store.mentorName(student.mentor_id), groupWinRate: gn ? Math.round((gw / gn) * 10000) / 100 : null, groupTrades: gn,
      });
    }
    throw new HttpError(404, "not_found");
  }

  throw new HttpError(404, "not_found");
}

export function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError || err instanceof AuthError || err instanceof store.StoreError)
        return send(res, err.status, { ok: false, error: err.error, message: err.message });
      console.error(err);
      send(res, 500, { ok: false, error: "server", message: "Error del servidor. Inténtalo más tarde." });
    });
  });
}
