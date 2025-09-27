// /dist/api/chat.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: "message required" });

    const key = process.env.OPENAI_API_KEY;
    if (!key) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.4,
        messages: [
          { role: "system", content: "Tu es un assistant pour un site de pierres/marbre. Réponds naturellement en FR. Si la question n'est pas produit/prix, réponds normalement." },
          { role: "user", content: message }
        ]
      })
    });

    const data = await r.json();
    if (data?.error) return res.status(500).json({ error: data.error.message });

    const reply = data?.choices?.[0]?.message?.content || "D’accord.";
    return res.status(200).json({ reply });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}
