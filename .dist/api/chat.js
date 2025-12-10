// ----- Runtime Node -----
export const config = { runtime: "nodejs" };

// ---- Allowed origins ----
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
  res.setHeader("Content-Type", "application/json");
  res.status(status).end(JSON.stringify(data));
}
const bad = (req, res, msg) => send(res, 400, { error: msg }, pickOrigin(req));
const server = (req, res, msg) =>
  send(res, 500, { error: msg || "server error" }, pickOrigin(req));

import { createClient } from "@supabase/supabase-js";

// ---- Supabase (Service Role key for backend inserts) ----
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---- COMMAND PARSER ----
function parseOrderMessage(text) {
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
    raw: payload
  };

  if (!order.phone) return null;
  return order;
}

// ---- INSERT INTO SUPABASE ----
async function saveOrder(order) {
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

  if (error) throw error;
  return data;
}

// ---- CHATBOT HANDLER ----
export default async function handler(req, res) {
  // Preflight
  if (req.method === "OPTIONS") {
    const o = pickOrigin(req);
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  if (req.method !== "POST") return bad(req, res, "Use POST");

  let body = req.body;
  if (!body || typeof body !== "object") {
    try {
      body = JSON.parse(req.body);
    } catch {}
  }

  const message = (body?.message ?? "").toString().trim();
  if (!message) return bad(req, res, "Message required");

  // ---- 1) CHECK IF USER IS MAKING AN ORDER ----
  const order = parseOrderMessage(message);

  if (order) {
    try {
      const saved = await saveOrder(order);

      return send(res, 200, {
        reply:
          `🧾 Votre commande a été enregistrée avec succès !\n\n` +
          `👤 Nom : ${order.customer_name || "(non fourni)"}\n` +
          `📞 Téléphone : ${order.phone}\n` +
          `🪨 Produit : ${order.product_filename || "(non fourni)"}\n` +
          `📦 Quantité : ${order.quantity || "(non fournie)"} m²\n\n` +
          `Nous vous contacterons très prochainement.`,
      }, pickOrigin(req));
    } catch (e) {
      return server(req, res, "Erreur lors de l’enregistrement de la commande");
    }
  }

  // ---- 2) OTHERWISE -> FALLBACK OPENAI ----
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const call = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.4,
        messages: [
          { role: "system", content: "Assistant TravauxPierre, réponses courtes." },
          { role: "user", content: message },
        ],
      }),
    });

    const json = await call.json();
    return send(res, 200, { reply: json.choices?.[0]?.message?.content || "Pas de réponse" }, pickOrigin(req));

  } catch (e) {
    return server(req, res, "Erreur OpenAI");
  }
}
