// /dist/api/chat.js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // ta clé depuis Vercel
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Méthode non autorisée" });
  }

  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message requis" });
    }

    // Appel à OpenAI (GPT-4o-mini pour rapidité/prix)
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Tu es un assistant qui répond de façon naturelle aux utilisateurs d'un site de pierres décoratives. Tu peux répondre aux questions générales et afficher les prix/images des produits." },
        { role: "user", content: message }
      ],
    });

    const reply = completion.choices[0].message.content;

    res.status(200).json({ reply });
  } catch (error) {
    console.error("Erreur OpenAI:", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
}
