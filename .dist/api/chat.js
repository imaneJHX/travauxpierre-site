// api/chat.js

import { createClient } from "@supabase/supabase-js";

// ----- Runtime Node -----
export const config = { runtime: "nodejs" };

// ----- ENV / CONFIG -----
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Crée le client Supabase avec la Service Role (backend uniquement)
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

// ---- Allowed origins (CORS) ----
const ALLOWED_ORIGINS = [
  process.env.PUBLIC_SITE_ORIGIN || "https://travauxpierre-site.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
];

// ---- CORS helpers ----
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

function bad(req, res, msg) {
  return send(res, 400, { error: msg }, pickOrigin(req));
}

function server(req, res, msg) {
  return send(
    res,
    500,
    { error: msg || "server error" },
    pickOrigin(req)
  );
}

// --------- PARSEUR DE COMMANDE ---------
function parseOrderMessage(text) {
  // On ne traite que les messages qui commencent par "commande:"
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
    unit: "m²",
    raw: payload,
  };

  // On exige au moins un téléphone pour pouvoir rappeler le client
  if (!order.phone) return null;

  return order;
}

// --------- INSERTION DANS SUPABASE ---------
async function saveOrder(order) {
  if (!supabase) {
    throw new Error("Supabase n'est pas configuré côté serveur");
  }

  const { data, error } = await supabase
    .from("order_request")
    .insert([
      {
        customer_name: order.customer_name,
        phone: order.phone,
        product_filename: order.product_filename,
        quantity: order.quantity ? Number(order.quantity) : null,
        unit: order.unit,
        raw_message: order.raw,
      },
    ])
    .select()
    .single();

  if (error) {
    console.error("Supabase insert error:", error);
    throw error;
  }

  return data;
}

// --------- HANDLER PRINCIPAL ---------
export default async function handler(req, res) {
  // Préflight CORS
  if (req.method === "OPTIONS") {
    const o = pickOrigin(req);
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return bad(req, res, "Use POST");
  }

  // Parsing du body
  let body = req.body;
  if (!body || typeof body !== "object") {
    try {
      body = JSON.parse(req.body);
    } catch {
      /* ignore */
    }
  }

  const message = (body?.message ?? "").toString().trim();
  if (!message) return bad(req, res, "Message required");

  // ------------ 1) TENTATIVE DE COMMANDE ------------
  try {
    const order = parseOrderMessage(message);

    if (order) {
      const saved = await saveOrder(order); // eslint-disable-line no-unused-vars

      return send(
        res,
        200,
        {
          reply:
            `🧾 Votre commande a été enregistrée avec succès !\n\n` +
            `👤 Nom : ${order.customer_name || "(non fourni)"}\n` +
            `📞 Téléphone : ${order.phone}\n` +
            `🪨 Produit : ${order.product_filename || "(non fourni)"}\n` +
            `📦 Quantité : ${order.quantity || "(non fournie)"} ${order.unit}\n\n` +
            `Nous vous contacterons très prochainement pour confirmer les détails.`,
        },
        pickOrigin(req)
      );
    }
  } catch (e) {
    console.error("Erreur lors de l'enregistrement de la commande:", e);
    return server(
      req,
      res,
      "Erreur lors de l’enregistrement de la commande."
    );
  }

  // ------------ 2) SINON : MODE CHAT OPENAI ------------
  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY manquante");
    return server(req, res, "Configuration OpenAI manquante");
  }

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 400,
        messages: [
          {
            role: "system",
            content:
              "Tu es l'assistant du site TravauxPierre. " +
              "Réponds en français, de manière courte et claire. " +
              "Si l'utilisateur parle de marbre, pierre, prix, surfaces, " +
              "donne des réponses simples et utiles.",
          },
          { role: "user", content: message },
        ],
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.error("OpenAI HTTP error:", resp.status, txt);
      return server(req, res, "Erreur OpenAI");
    }

    const json = await resp.json();
    const reply =
      json?.choices?.[0]?.message?.content?.trim() ||
      "Désolé, je n’ai pas pu répondre.";

    return send(res, 200, { reply }, pickOrigin(req));
  } catch (e) {
    console.error("Exception OpenAI:", e);
    return server(req, res, "Erreur OpenAI");
  }
}
