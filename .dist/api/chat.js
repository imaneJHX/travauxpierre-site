// /dist/api/chat.js

// Forcer le runtime Node (pas Edge)
export const config = { runtime: "nodejs" };

// ----------- CONFIG SUPABASE (backend uniquement) -----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Domaines autorisés (tu peux ajuster ou mettre PUBLIC_SITE_ORIGIN dans Vercel)
const ALLOWED_ORIGINS = [
  process.env.PUBLIC_SITE_ORIGIN || "https://travauxpierre-site.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

// ---------- Helpers CORS/JSON ----------
function pickOrigin(req) {
  const o = req.headers?.origin || "";
  return ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0];
}
function send(res, status, data, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(status).end(JSON.stringify(data));
}
function withCors(req, res, status = 200, data = {}) {
  const origin = pickOrigin(req);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return send(res, status, data, origin);
}
const badRequest = (req, res, msg) => withCors(req, res, 400, { error: msg });
const serverError = (req, res, msg) =>
  withCors(req, res, 500, { error: msg || "server error" });

// ----------- PARSER COMMANDE -----------
function parseOrderMessage(text) {
  // On détecte "commande:" au début
  if (!/^commande\s*:/i.test(text)) return null;

  const payload = text.replace(/^commande\s*:/i, "").trim();

  const get = (key) => {
    const re = new RegExp(key + "\\s*=\\s*([^,]+)", "i");
    const m = payload.match(re);
    return m ? m[1].trim() : null;
  };

  const order = {
    customer_name: get("nom") || get("name"),
    phone: get("tel") || get("telephone") || get("phone"),
    product_filename: get("produit") || get("product"),
    quantity: get("quantite") || get("qty"),
    unit: get("unit") || get("unite") || "m²",
    note: get("note") || null,
  };

  // Vérification minimale : au moins téléphone ou produit
  if (!order.product_filename && !order.phone) return null;

  return order;
}

// ----------- INSERTION COMMANDE SUPABASE (via REST) -----------
async function insertOrder(order, rawText) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Supabase env vars manquantes");
    throw new Error("Supabase configuration missing");
  }

  const url = `${SUPABASE_URL}/rest/v1/order_request`;

  const payload = {
    customer_name: order.customer_name,
    phone: order.phone,
    product_filename: order.product_filename,
    quantity: order.quantity ? Number(order.quantity) : null,
    unit: order.unit,
    note: order.note,
    raw_message: rawText,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error("Supabase insert error", resp.status, text);
    throw new Error(`Supabase insert failed: ${resp.status}`);
  }

  const data = await resp.json().catch(() => null);
  return data;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  // Préflight
  if (req.method === "OPTIONS") {
    const origin = pickOrigin(req);
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return withCors(req, res, 405, { error: "Use POST" });
  }

  try {
    // Body (selon Vercel, déjà parsé ou non)
    let body = req.body;
    if (!body || typeof body !== "object") {
      try {
        body = JSON.parse(req.body);
      } catch {}
    }
    const message = (body?.message ?? "").toString().trim();
    if (!message) return badRequest(req, res, "message required");

    // 1) Mode COMMANDE : "commande: nom=..., tel=..., produit=..., quantite=..."
    const maybeOrder = parseOrderMessage(message);
    if (maybeOrder) {
      try {
        await insertOrder(maybeOrder, message);
        return withCors(req, res, 200, {
          reply:
            "✅ Votre demande de commande a été bien enregistrée. " +
            "Nous vous contacterons pour confirmer les détails.",
        });
      } catch (e) {
        console.error("insertOrder error", e);
        return serverError(
          req,
          res,
          "Impossible d'enregistrer la commande pour le moment."
        );
      }
    }

    // 2) Sinon : mode Chat OpenAI normal

    // Clé OpenAI
    const key = (process.env.OPENAI_API_KEY || "").trim();
    if (!key || key.length < 20) {
      return serverError(req, res, "Missing OPENAI_API_KEY");
    }

    // Timeout (15s)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    // Appel OpenAI (Chat Completions) avec fallback de modèle
    const primary = "gpt-4o-mini";
    const fallback = "gpt-4o-mini-2024-07-18";

    const call = (model) =>
      fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          max_tokens: 400,
          messages: [
            {
              role: "system",
              content:
                "Tu es un assistant pour un site de pierres/marbre. Réponds naturellement en français. " +
                "Si la question parle de produits/prix/images, sois concis et utile. Sinon, réponds normalement.",
            },
            { role: "user", content: message },
          ],
        }),
        signal: controller.signal,
      });

    let resp = await call(primary);
    if (!resp.ok) {
      // On tente un autre modèle une fois
      resp = await call(fallback);
    }

    clearTimeout(timeout);

    if (!resp.ok) {
      let errText = "";
      try {
        errText = await resp.text();
      } catch {}
      console.error("OpenAI HTTP error:", resp.status, errText || resp.statusText);
      return serverError(
        req,
        res,
        `OpenAI HTTP ${resp.status}: ${errText || resp.statusText}`
      );
    }

    const data = await resp.json();
    if (data?.error) {
      console.error("OpenAI API error payload:", data);
      return serverError(req, res, data.error.message || "OpenAI error");
    }

    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      console.error(
        "OpenAI empty reply payload:",
        JSON.stringify(data).slice(0, 2000)
      );
      return serverError(req, res, "Empty reply from OpenAI");
    }

    return withCors(req, res, 200, { reply });
  } catch (e) {
    if (e?.name === "AbortError") {
      return serverError(req, res, "OpenAI request timed out");
    }
    console.error("API /api/chat exception:", e);
    return serverError(req, res);
  }
}
