// /dist/api/chat.js

// -- Vercel: forcer runtime Node (pas Edge)
export const config = { runtime: "nodejs" };

/**
 * Domaines autorisés à appeler l'API.
 * Tu peux aussi fournir PUBLIC_SITE_ORIGIN dans Vercel si tu veux gérer ça sans re-déployer.
 */
const ALLOWED_ORIGINS = [
  process.env.PUBLIC_SITE_ORIGIN || "https://travauxpierre-site.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

// --- Helpers ---------------------------------------------------------------
function pickOrigin(req) {
  const o = req.headers?.origin || "";
  return ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0];
}

function writeJson(res, status, data, origin) {
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
  return writeJson(res, status, data, origin);
}

function badRequest(req, res, msg) {
  return withCors(req, res, 400, { error: msg });
}
function serverError(req, res, msg) {
  return withCors(req, res, 500, { error: msg || "server error" });
}

// --- Handler ---------------------------------------------------------------
export default async function handler(req, res) {
  // Pré-flight CORS
  if (req.method === "OPTIONS") {
    const origin = pickOrigin(req);
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(204).end(); // pas de body pour OPTIONS
  }

  if (req.method !== "POST") {
    return withCors(req, res, 405, { error: "Use POST" });
  }

  try {
    // Tenter de récupérer un JSON, quelle que soit la manière dont Vercel le passe
    let body = req.body;
    if (!body || typeof body !== "object") {
      try { body = JSON.parse(req.body); } catch { /* ignore */ }
    }
    const message = (body?.message ?? "").toString().trim();
    if (!message) return badRequest(req, res, "message required");

    // Clé OpenAI depuis Vercel (Settings > Environment Variables)
    const key = (process.env.OPENAI_API_KEY || "").trim();
    if (!key || key.length < 20) {
      return serverError(req, res, "Missing OPENAI_API_KEY");
    }

    // Timeout pour éviter de bloquer trop longtemps
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    // Appel OpenAI (Chat Completions)
    // Modèle principal + fallback si indisponible
    const modelPrimary = "gpt-4o-mini";
    const modelFallback = "gpt-4o-mini-2024-07-18";

    async function callOpenAI(model) {
      return fetch("https://api.openai.com/v1/chat/completions", {
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
    }

    let r = await callOpenAI(modelPrimary);
    if (!r.ok) {
      // Si problème côté modèle, on tente un fallback une fois
      r = await callOpenAI(modelFallback);
    }

    clearTimeout(timeout);

    if (!r.ok) {
      // Lire la réponse textuelle pour debug
      let errText = "";
      try { errText = await r.text(); } catch {}
      return serverError(
        req,
        res,
        `OpenAI HTTP ${r.status}: ${errText || r.statusText}`
      );
    }

    const data = await r.json();

    if (data?.error) {
      return serverError(req, res, data.error.message || "OpenAI error");
    }

    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      return serverError(req, res, "Empty reply from OpenAI");
    }

    return withCors(req, res, 200, { reply });
  } catch (e) {
    if (e?.name === "AbortError") {
      return serverError(req, res, "OpenAI request timed out");
    }
    console.error("API /api/chat error:", e);
    return serverError(req, res);
  }
}
