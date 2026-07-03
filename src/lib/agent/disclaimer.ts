// AI-transparency disclaimer + human opt-out, appended to every outgoing draft,
// localized to the customer's language. The opt-out trigger word in each locale
// (ΑΝΘΡΩΠΟΣ / HUMAN / MENSCH / …) is also a keyword in the `human_requested`
// red-line rule (see redlines.ts), so a reply containing it escalates to a human.
//
// Wording note: drafts are human-reviewed before sending, but we disclose the AI
// authorship plainly — transparency by default. Edit the strings here to tweak.

const DISCLAIMERS: Record<string, string> = {
  el: "Αυτό το μήνυμα ετοιμάστηκε αυτόματα από τον AI βοηθό μας. Αν προτιμάτε να σας εξυπηρετήσει άτομο της ομάδας μας, απαντήστε με τη λέξη **ΑΝΘΡΩΠΟΣ** και θα αναλάβει συνεργάτης μας.",
  en: "This message was prepared automatically by our AI assistant. If you'd prefer to speak with a member of our team, reply with the word **HUMAN** and a colleague will take over.",
  de: "Diese Nachricht wurde automatisch von unserem KI-Assistenten erstellt. Wenn Sie lieber mit einer Person aus unserem Team sprechen möchten, antworten Sie mit dem Wort **MENSCH** und ein Kollege übernimmt.",
  fr: "Ce message a été préparé automatiquement par notre assistant IA. Si vous préférez parler à une personne de notre équipe, répondez avec le mot **HUMAIN** et un collègue prendra le relais.",
  it: "Questo messaggio è stato preparato automaticamente dal nostro assistente AI. Se preferisci parlare con una persona del nostro team, rispondi con la parola **OPERATORE** e un collega ti assisterà.",
  es: "Este mensaje ha sido preparado automáticamente por nuestro asistente de IA. Si prefieres hablar con una persona de nuestro equipo, responde con la palabra **HUMANO** y un compañero se encargará.",
  nl: "Dit bericht is automatisch opgesteld door onze AI-assistent. Wilt u liever met een medewerker spreken? Antwoord met het woord **MENS** en een collega neemt het over.",
  pt: "Esta mensagem foi preparada automaticamente pelo nosso assistente de IA. Se preferir falar com uma pessoa da nossa equipa, responda com a palavra **HUMANO** e um colega assumirá.",
};

/** The disclaimer for a message language (ISO code); English is the fallback. */
export function disclaimerFor(language?: string): string {
  const lang = (language ?? "").trim().slice(0, 2).toLowerCase();
  return DISCLAIMERS[lang] ?? DISCLAIMERS.en;
}
