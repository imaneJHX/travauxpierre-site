// api/chat.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const { message } = req.body ?? {};
    if (!message) return res.status(400).json({ error: "message required" });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // ---- Prompt + JSON schema pour extraire les intentions
    const system = `Tu es un assistant qui convertit les demandes utilisateur en
    a) "search" pour filtrer une galerie Supabase d'images de pierres (champs: type_guess, page, price_min_mad, price_max_mad, filename),
    b) "smalltalk" pour questions générales. 
    Renvoie UNIQUEMENT un JSON valide selon ce schema:
    {
      "intent": "search" | "smalltalk",
      "keywords": string | null,
      "page": "Accueil" | "Services" | "Marbre & Granit" | null,
      "min": number | null,
      "max": number | null,
      "limit": number | null,
      "answer": string | null
    }
    Règles:
    - Si l'utilisateur demande à "voir/montrer/afficher", intent="search".
    - "prix < N" => max=N; "prix > N" => min=N; "prix A-B" => min=A, max=B.
    - pages reconnues: Accueil, Services, Marbre & Granit (ignore la casse, accents).
    - Si la demande est conversationnelle (pas une recherche), intent="smalltalk" et fournis "answer" (brève).
    - keywords = mots clés restants utiles pour rechercher dans type_guess/filename/page. 
    - limit par défaut = 12 (borne 1..50).
    `;

    // Appel OpenAI (fetch générique pour éviter dépendances)
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // ou autre modèle adapté
        messages: [
          { role: "system", content: system },
          { role: "user", content: message }
        ],
        temperature: 0.2,
        response_format: { type: "json_object" }
      })
    });
    const data = await r.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    // Parse JSON retourné par le LLM
    let parsed;
    try { parsed = JSON.parse(data.choices[0].message.content); }
    catch { return res.status(500).json({ error: "LLM JSON parse error" }); }

    // Normalisation basique
    if (parsed.intent === "search") {
      // clamp du limit
      let limit = Number(parsed.limit || 12);
      limit = Math.max(1, Math.min(50, limit));
      return res.json({
        intent: "search",
        filters: {
          keywords: parsed.keywords || null,
          page: parsed.page || null,
          min: isFinite(parsed.min) ? Number(parsed.min) : null,
          max: isFinite(parsed.max) ? Number(parsed.max) : null,
          limit
        }
      });
    } else {
      return res.json({
        intent: "smalltalk",
        answer: parsed.answer || "Je peux aussi te montrer des images : essaie “marbre noir < 1200 MAD”."
      });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}
