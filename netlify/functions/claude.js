// Puente entre la tarea programada de Claude y Firestore.
// Uso (siempre con ?clave=...):
//   ?accion=pendientes            -> prendas con revisado=false (nuevas)
//   ?accion=pendientes&todas=1    -> todas las prendas no compradas (para revisar precios)
//   ?accion=guardar&id=..&foto=..&precio=..&nombre=..   -> completa una prenda
//   ?accion=fallo&id=..           -> suma un intento fallido (a los 3 deja de intentarlo)
// Variables de entorno en Netlify: CLAVE, FB_CLIENT_EMAIL, FB_PRIVATE_KEY
const crypto = require("crypto");

const PROYECTO = "shopping-list-giuli";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROYECTO}/databases/(default)/documents`;

const txt = (code, body) => ({
  statusCode: code,
  headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  body
});

let tokenCache = null;
async function token() {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.t;
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sinFirma = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
    iss: process.env.FB_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600
  });
  const clave = (process.env.FB_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const firma = crypto.createSign("RSA-SHA256").update(sinFirma).sign(clave, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + sinFirma + "." + firma
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("token: " + JSON.stringify(d).slice(0, 200));
  tokenCache = { t: d.access_token, exp: Date.now() + 3500000 };
  return d.access_token;
}

async function fs(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { Authorization: "Bearer " + await token(), "Content-Type": "application/json" }
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("firestore " + r.status + ": " + JSON.stringify(d).slice(0, 200));
  return d;
}

const val = v => v == null ? null : (v.stringValue ?? v.booleanValue ?? v.integerValue ?? v.doubleValue ?? null);
const idDe = name => name.split("/").pop();

function precioTexto(p) {
  const n = parseFloat(String(p || "").replace(/[^\d.,]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  if (!isFinite(n) || n <= 0) return "";
  return n.toFixed(2).replace(".", ",") + " €";
}

const BLOQUEO = /access denied|forbidden|just a moment|attention required|captcha|error 40\d/i;

async function actualizar(id, campos) {
  const mask = Object.keys(campos).map(k => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  const fields = {};
  for (const [k, v] of Object.entries(campos)) {
    fields[k] = typeof v === "boolean" ? { booleanValue: v }
      : typeof v === "number" ? { integerValue: String(v) }
      : { stringValue: String(v) };
  }
  await fs(`/prendas/${encodeURIComponent(id)}?${mask}&currentDocument.exists=true`, {
    method: "PATCH", body: JSON.stringify({ fields })
  });
}

exports.handler = async event => {
  const q = event.queryStringParameters || {};
  if (!process.env.CLAVE || q.clave !== process.env.CLAVE) return txt(401, "clave incorrecta");

  try {
    if (q.accion === "pendientes") {
      let docs;
      if (q.todas) {
        const d = await fs("/prendas?pageSize=300");
        docs = (d.documents || []).filter(x => !val(x.fields?.comprado));
      } else {
        const d = await fs(":runQuery", {
          method: "POST",
          body: JSON.stringify({ structuredQuery: {
            from: [{ collectionId: "prendas" }],
            where: { fieldFilter: { field: { fieldPath: "revisado" }, op: "EQUAL", value: { booleanValue: false } } },
            limit: 15
          } })
        });
        docs = d.filter(x => x.document).map(x => x.document);
      }
      const lineas = docs.map((x, i) => `${i + 1}. id=${idDe(x.name)} url=${val(x.fields?.url) || ""}`);
      return txt(200, `PENDIENTES: ${lineas.length}\n` + lineas.join("\n"));
    }

    if (q.accion === "guardar") {
      if (!q.id) return txt(400, "falta id");
      const actual = await fs(`/prendas/${encodeURIComponent(q.id)}`);
      const f = actual.fields || {};
      const campos = { revisado: true };
      if (q.foto && /^https:\/\/[^\s]+$/.test(q.foto)) campos.fotoUrl = q.foto;
      const nuevo = precioTexto(q.precio);
      const viejo = val(f.precio) || "";
      if (nuevo) {
        campos.precio = nuevo;
        if (viejo && viejo !== nuevo) campos.precioAnterior = viejo;
      }
      if (q.nombre && !BLOQUEO.test(q.nombre)) {
        const n = q.nombre.trim().toLowerCase().slice(0, 120);
        campos.nombre = n.charAt(0).toUpperCase() + n.slice(1);
      }
      await actualizar(q.id, campos);
      return txt(200, "GUARDADO " + q.id + " " + Object.keys(campos).join(","));
    }

    if (q.accion === "fallo") {
      if (!q.id) return txt(400, "falta id");
      const actual = await fs(`/prendas/${encodeURIComponent(q.id)}`);
      const n = Number(val(actual.fields?.intentos) || 0) + 1;
      await actualizar(q.id, n >= 3 ? { intentos: n, revisado: true } : { intentos: n });
      return txt(200, "FALLO " + q.id + " intento " + n);
    }

    return txt(400, "accion desconocida");
  } catch (e) {
    return txt(200, "ERROR " + e.message);
  }
};
