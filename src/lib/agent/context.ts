import type Anthropic from "@anthropic-ai/sdk";
import type { PromptContext } from "./types";

const SYSTEM_PERSONA = `Είσαι ο AI βοηθός του τμήματος Customer Service της The Fashion Project (TFP).
Κανόνες:
- ΓΛΩΣΣΑ: γράψε ΟΛΗ την απάντηση στη γλώσσα του πελάτη — ΣΥΜΠΕΡΙΛΑΜΒΑΝΟΜΕΝΩΝ του χαιρετισμού και του κλεισίματος/υπογραφής. Αν ο πελάτης δεν γράφει στα Ελληνικά, ΜΕΤΕΦΡΑΣΕ και την υπογραφή (π.χ. EN: «Kind regards, / The TFP customer support team»). Μην αφήνεις ελληνικές φράσεις σε ξενόγλωσση απάντηση.
- Βασίσου ΑΠΟΚΛΕΙΣΤΙΚΑ στις πολιτικές και στα δεδομένα που σου δίνονται. Μην εφευρίσκεις πληροφορίες, αριθμούς παραγγελιών, ποσά ή ημερομηνίες.
- Απάντησε σε ΟΛΑ τα σημεία του πελάτη. Αν εκφράζει παράπονο, δυσαρέσκεια ή σχόλιο (π.χ. για φωτογραφία, χρώμα, ποιότητα, μέγεθος), αναγνώρισέ το ΡΗΤΑ με ενσυναίσθηση — όχι μόνο το συναλλακτικό αίτημα.
- ΣΥΝΔΕΣΜΟΙ: όταν η γνώση περιέχει σχετικό link, συμπερίλαβέ το στην απάντηση ανάλογα με το θέμα (π.χ. επιστροφές → πύλη RMA, μεγέθη → οδηγός μεγεθών).
- Αν λείπει πληροφορία ή δεν είσαι σίγουρος, ζήτησέ την ευγενικά ή ζήτησε ανάληψη από συνάδελφο — μην μαντεύεις.
- ΠΟΤΕ μην υπόσχεσαι ή εκτελείς μη αναστρέψιμες ενέργειες (επιστροφή χρημάτων, ακύρωση/αλλαγή παραγγελίας). Πρότεινε τη λύση· την εκτέλεση την κάνει άνθρωπος.
- Ύφος, χαιρετισμός και υπογραφή: ακολούθησε τις οδηγίες στη γνώση («Ύφος επικοινωνίας», «Υπογραφή & τυπικές φράσεις»). Σύντομο, ζεστό, επαγγελματικό.`;

/**
 * System blocks for the drafting call. The policies block carries the
 * prompt-cache breakpoint — it is byte-identical across every email, so with
 * steady volume it stays warm and is billed at ~0.1x input cost.
 */
export function buildSystemBlocks(
  ctx: PromptContext,
): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: SYSTEM_PERSONA },
    {
      type: "text",
      text: `# Γνώση / Πολιτικές\n${ctx.policies}`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

/**
 * The volatile part of the prompt: rolling case summary + recent verbatim
 * messages + the new inbound message + any fresh Shopify data.
 */
export function buildMessages(ctx: PromptContext): Anthropic.MessageParam[] {
  const history = ctx.recentMessages
    .map((m) => `[${m.direction === "INBOUND" ? "Πελάτης" : "Εμείς"}] ${m.body}`)
    .join("\n\n");

  const text = [
    ctx.subject && `# Θέμα email\n${ctx.subject}`,
    ctx.caseSummary && `# Περίληψη υπόθεσης (rolling)\n${ctx.caseSummary}`,
    ctx.shopifyContext && `# Δεδομένα Shopify\n${ctx.shopifyContext}`,
    history && `# Πρόσφατα μηνύματα\n${history}`,
    `# Νέο μήνυμα πελάτη (προς απάντηση)\n${ctx.incomingMessage}`,
    ctx.images?.length &&
      `# Συνημμένες εικόνες πελάτη\nΟ πελάτης επισύναψε ${ctx.images.length} εικόνα(ες) (παρακάτω). Λάβε τις υπόψη στην απάντηση.`,
    ctx.reviewerGuidance &&
      `# Οδηγία ελεγκτή (το προηγούμενο draft απορρίφθηκε — διόρθωσέ το)\n${ctx.reviewerGuidance}`,
    `Σύνταξε την απάντηση (draft) προς τον πελάτη.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!ctx.images?.length) {
    return [{ role: "user", content: text }];
  }

  const imageBlocks: Anthropic.ImageBlockParam[] = ctx.images.map((img) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: img.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
      data: img.data,
    },
  }));
  return [{ role: "user", content: [{ type: "text", text }, ...imageBlocks] }];
}
