// © Josué Morales Carmona · DayTraderProfesional (DTP)
//
// Autenticación del AddOn con el token de licencia DTP (sin secretos compartidos).
//  · El servidor de licencias firma con ECDSA P-256 (firma IEEE P1363) "cuerpo.firma" en base64url.
//  · Aquí solo se VERIFICA con la clave pública (LICENSE_PUBLIC_KEY, la de GET /public-key:
//    base64 de 0x04|X|Y). La clave privada nunca sale del servidor de licencias.
//  · El token vale si: firma correcta, v=1, no caducado, el machine_id coincide y
//    "lic" incluye el producto DTP Mentor (MENTOR_PRODUCT_CODE).
import { webcrypto as crypto, timingSafeEqual } from "node:crypto";

const enc = new TextEncoder();
let PUB = null;

export async function publicKey() {
  if (PUB) return PUB;
  const b64 = String(process.env.LICENSE_PUBLIC_KEY || "").trim();
  if (!b64) throw new Error("FALTA LICENSE_PUBLIC_KEY (la de GET /public-key del servidor de licencias)");
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("LICENSE_PUBLIC_KEY no válida");
  PUB = await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return PUB;
}

/** Solo para pruebas: usar otra clave pública. */
export function _setPublicKey(k) { PUB = k; }

export class AuthError extends Error {
  constructor(status, error, message) { super(message); this.status = status; this.error = error; }
}

export async function verifyLicense(token, machineId, now = Date.now()) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) throw new AuthError(401, "no_token", "Falta la licencia.");
  let ok = false, p = null;
  try {
    ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await publicKey(), Buffer.from(sig, "base64url"), enc.encode(body));
    if (ok) p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch { ok = false; }
  if (!ok || !p || p.v !== 1) throw new AuthError(401, "bad_token", "Licencia no válida.");
  if (!(p.exp * 1000 > now)) throw new AuthError(401, "expired", "Licencia caducada. NinjaTrader la renovará sola en un minuto.");
  if (!machineId || p.mid !== machineId) throw new AuthError(401, "bad_machine", "La licencia no es de este ordenador.");
  const code = process.env.MENTOR_PRODUCT_CODE || "";
  if (!code || !Array.isArray(p.lic) || !p.lic.includes(code)) throw new AuthError(403, "no_product", "Tu licencia no incluye DTP Mentor.");
  const email = String(p.sub || "").trim().toLowerCase();
  if (!email) throw new AuthError(401, "bad_token", "Licencia no válida.");
  return { email, machineId: p.mid, exp: p.exp };
}

export function isAdmin(req) {
  const secret = process.env.MENTOR_ADMIN_SECRET || "";
  const got = Buffer.from(String(req.headers["x-admin-secret"] || ""));
  const want = Buffer.from(secret);
  return secret.length >= 24 && got.length === want.length && timingSafeEqual(got, want);
}
