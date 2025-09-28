// /dist/api/chat.js

// Forcer le runtime Node (pas Edge)
export const config = { runtime: "nodejs" };

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
const serverError = (req, res, msg) => withCors(req, res, 500, { error: msg || "server error" });

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
      try { body = JSON.parse(req.body); } catch {}
    }
    const message = (body?.message ?? "").toString().trim();
    if (!message) return badRequest(req, res, "message required");

    // Clé OpenAI
    const key = (process.env.OPENAI_API_KEY || "").trim();
    if (!key.startsWith("sk-") || key.length < 20) {
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
          "Authorization": `Bearer ${key}`,
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
      try { errText = await resp.text(); } catch {}
      // Log serveur pour debug
      console.error("OpenAI HTTP error:", resp.status, errText || resp.statusText);
      return serverError(req, res, `OpenAI HTTP ${resp.status}: ${errText || resp.statusText}`);
    }

    const data = await resp.json();
    if (data?.error) {
      console.error("OpenAI API error payload:", data);
      return serverError(req, res, data.error.message || "OpenAI error");
    }

    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      console.error("OpenAI empty reply payload:", JSON.stringify(data).slice(0, 2000));
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
