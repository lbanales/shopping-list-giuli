// Puente entre la tarea programada de Claude y Firestore. Dirección corta: /c
// Parámetros cortos (la herramienta web de Claude solo acepta URLs de ~250 caracteres):
//   k = clave
//   a = p  -> pendientes (revisado=false)      a = t -> todas las no compradas
//   a = g  -> guardar: i=id, f=foto, t=ts de la foto, p=precio, n=nombre
//   a = x  -> fallo: i=id (a los 3 intentos deja de reintentar)
// f puede ser la URL completa o solo lo que va después de /assets/public/
// Variables de entorno en Netlify: CLAVE, FB_CLIENT_EMAIL, FB_PRIVATE_KEY
import crypto from "node:crypto";

export const config = { path: "/c" };

const BASE = "https://firestore.googleapis.com/v1/projects/shopping-list-giuli/databases/(default)/documents";
const CDN = { zara: "static.zara.net", stradivarius: "static.e-stradivarius.net", pullandbear: "static.pullandbear.net", bershka: "static.bershka.net" };
const BLOQUEO = /access denied|forbidden|just a moment|attention required|captcha|error 40\d/i;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

let tokenCache = null;
async function token() {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.t;
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sinFirma = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
    iss: process.env.FB_CLIENT_EMAIL, scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600
  });
  const clave = (process.env.FB_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const firma = crypto.createSign("RSA-SHA256").update(sinFirma).sign(clave, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + sinFirma + "." + firma
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("token: " + JSON.stringify(d).slice(0, 200));
  tokenCache = { t: d.access_token, exp: Date.now() + 3500000 };
  return d.access_token;
}

async function fs(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { Authorization: "Bearer " + await token(), "Content-Type": "application/json" } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("firestore " + r.status + ": " + JSON.stringify(d).slice(0, 200));
  return d;
}

const val = v => v == null ? null : (v.stringValue ?? v.booleanValue ?? v.integerValue ?? v.doubleValue ?? null);

function precioTexto(p) {
  const n = parseFloat(String(p || "").replace(/[^\d.,]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  return isFinite(n) && n > 0 ? n.toFixed(2).replace(".", ",") + " €" : "";
}

function fotoCompleta(f, ts, urlPrenda) {
  if (!f) return "";
  if (/^https:\/\/\S+$/.test(f)) return f;
  const tienda = Object.keys(CDN).find(k => (urlPrenda || "").includes(k));
  if (!tienda || !/^[\w\-\/.]+\.(jpe?g|png|webp)$/i.test(f)) return "";
  const extra = [ts ? "ts=" + ts : "", tienda === "pullandbear" ? "" : "w=560"].filter(Boolean).join("&");
  return `https://${CDN[tienda]}/assets/public/${f.replace(/^\/+/, "")}` + (extra ? "?" + extra : "");
}

async function actualizar(id, campos) {
  const mask = Object.keys(campos).map(k => "updateMask.fieldPaths=" + k).join("&");
  const fields = {};
  for (const [k, v] of Object.entries(campos)) {
    fields[k] = typeof v === "boolean" ? { booleanValue: v } : typeof v === "number" ? { integerValue: String(v) } : { stringValue: String(v) };
  }
  await fs(`/prendas/${encodeURIComponent(id)}?${mask}&currentDocument.exists=true`, { method: "PATCH", body: JSON.stringify({ fields }) });
}

export default async req => {
  const q = Object.fromEntries(new URL(req.url).searchParams);
  if (!process.env.CLAVE || q.k !== process.env.CLAVE) return json({ ok: false, error: "clave" }, 401);
  try {
    if (q.a === "p" || q.a === "t") {
      let docs;
      if (q.a === "t") {
        docs = ((await fs("/prendas?pageSize=300")).documents || []).filter(x => !val(x.fields?.comprado));
      } else {
        const d = await fs(":runQuery", { method: "POST", body: JSON.stringify({ structuredQuery: {
          from: [{ collectionId: "prendas" }],
          where: { fieldFilter: { field: { fieldPath: "revisado" }, op: "EQUAL", value: { booleanValue: false } } },
          limit: 15 } }) });
        docs = d.filter(x => x.document).map(x => x.document);
      }
      const lista = docs.map(x => ({ id: x.name.split("/").pop(), url: val(x.fields?.url) || "" }));
      return json({ ok: true, total: lista.length, pendientes: lista });
    }
    if (q.a === "g") {
      if (!q.i) return json({ ok: false, error: "falta id" }, 400);
      const f = (await fs(`/prendas/${encodeURIComponent(q.i)}`)).fields || {};
      const campos = { revisado: true };
      const foto = fotoCompleta(q.f, q.t, val(f.url));
      if (foto) campos.fotoUrl = foto;
      const nuevo = precioTexto(q.p), viejo = val(f.precio) || "";
      if (nuevo) { campos.precio = nuevo; if (viejo && viejo !== nuevo) campos.precioAnterior = viejo; }
      if (q.n && !BLOQUEO.test(q.n)) { const n = q.n.trim().toLowerCase().slice(0, 120); campos.nombre = n.charAt(0).toUpperCase() + n.slice(1); }
      await actualizar(q.i, campos);
      return json({ ok: true, guardado: q.i, campos: Object.keys(campos), foto: foto || null });
    }
    if (q.a === "x") {
      if (!q.i) return json({ ok: false, error: "falta id" }, 400);
      const f = (await fs(`/prendas/${encodeURIComponent(q.i)}`)).fields || {};
      const n = Number(val(f.intentos) || 0) + 1;
      await actualizar(q.i, n >= 3 ? { intentos: n, revisado: true } : { intentos: n });
      return json({ ok: true, fallo: q.i, intentos: n });
    }
    return json({ ok: false, error: "accion" }, 400);
  } catch (e) {
    return json({ ok: false, error: e.message });
  }
};
