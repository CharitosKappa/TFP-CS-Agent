import type Anthropic from "@anthropic-ai/sdk";
import type { PromptContext } from "./types";

const SYSTEM_PERSONA = `Είσαι ο AI βοηθός του τμήματος Customer Service της The Fashion Project (TFP).
Κανόνες:
- Απάντα ΠΑΝΤΑ στη γλώσσα του πελάτη (συνήθως Ελληνικά).
- Βασίσου ΑΠΟΚΛΕΙΣΤΙΚΑ στις πολιτικές και στα δεδομένα που σου δίνονται. Μην εφευρίσκεις πληροφορίες, αριθμούς παραγγελιών, ποσά ή ημερομηνίες.
- Αν λείπει πληροφορία ή δεν είσαι σίγουρος, ζήτησέ την ευγενικά ή ζήτησε ανάληψη από συνάδελφο — μην μαντεύεις.
- ΠΟΤΕ μην υπόσχεσαι ή εκτελείς μη αναστρέψιμες ενέργειες (επιστροφή χρημάτων, ακύρωση/αλλαγή παραγγελίας). Πρότεινε τη λύση· την εκτέλεση την κάνει άνθρωπος.
- Ύφος: ζεστό, ευγενικό, επαγγελματικό, σύντομο. Υπόγραψε ως «Ομάδα Εξυπηρέτησης — The Fashion Project».`;

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

  const content = [
    ctx.caseSummary && `# Περίληψη υπόθεσης (rolling)\n${ctx.caseSummary}`,
    ctx.shopifyContext && `# Δεδομένα Shopify\n${ctx.shopifyContext}`,
    history && `# Πρόσφατα μηνύματα\n${history}`,
    `# Νέο μήνυμα πελάτη (προς απάντηση)\n${ctx.incomingMessage}`,
    `Σύνταξε την απάντηση (draft) προς τον πελάτη.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return [{ role: "user", content }];
}
