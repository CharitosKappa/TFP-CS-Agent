import type Anthropic from "@anthropic-ai/sdk";
import type { PromptContext } from "./types";

const SYSTEM_PERSONA = `Είσαι ο AI βοηθός του τμήματος Customer Service της The Fashion Project (TFP).
Κανόνες:
- ΓΛΩΣΣΑ: γράψε ΟΛΗ την απάντηση στη γλώσσα του πελάτη — ΣΥΜΠΕΡΙΛΑΜΒΑΝΟΜΕΝΩΝ του χαιρετισμού και του κλεισίματος/υπογραφής. Αν ο πελάτης δεν γράφει στα Ελληνικά, ΜΕΤΕΦΡΑΣΕ και την υπογραφή (π.χ. EN: «Kind regards, / The TFP customer support team»). Μην αφήνεις ελληνικές φράσεις σε ξενόγλωσση απάντηση.
- Βασίσου ΑΠΟΚΛΕΙΣΤΙΚΑ στις πολιτικές και στα δεδομένα που σου δίνονται. Μην εφευρίσκεις πληροφορίες, αριθμούς παραγγελιών, ποσά ή ημερομηνίες.
- Απάντησε σε ΟΛΑ τα σημεία του πελάτη. Αν εκφράζει παράπονο, δυσαρέσκεια ή σχόλιο (π.χ. για φωτογραφία, χρώμα, ποιότητα, μέγεθος), αναγνώρισέ το ΡΗΤΑ με ενσυναίσθηση — όχι μόνο το συναλλακτικό αίτημα.
- ΣΥΝΔΕΣΜΟΙ: όταν η γνώση περιέχει σχετικό link, συμπερίλαβέ το στην απάντηση ανάλογα με το θέμα (π.χ. επιστροφές → πύλη RMA, μεγέθη → οδηγός μεγεθών).
- Αν λείπει πληροφορία ή δεν είσαι σίγουρος, ζήτησέ την ευγενικά από τον πελάτη — μην μαντεύεις.
- Μπορεί να σου δοθούν ΑΛΛΕΣ πρόσφατες συνομιλίες του ίδιου πελάτη (π.χ. άνοιξε νέο thread αντί να απαντήσει στο υπάρχον). Λάβε τες υπόψη για πληρότητα/συνέπεια, αλλά απάντησε ΜΟΝΟ στο τρέχον μήνυμα/thread — μην αναφέρεις ή αντιγράφεις τα άλλα threads εκτός αν είναι σαφώς σχετικά.
- ΠΟΤΕ μην υπόσχεσαι ή εκτελείς μη αναστρέψιμες ενέργειες (επιστροφή χρημάτων, ακύρωση/αλλαγή παραγγελίας). Πρότεινε τη λύση· την εκτέλεση την κάνει άνθρωπος.
- ΜΗΝ υπόσχεσαι στον πελάτη συγκεκριμένες ΕΣΩΤΕΡΙΚΕΣ δρομολογήσεις που δεν ελέγχεις (π.χ. «θα το προωθήσω σε συνάδελφο», «θα το δει ο υπεύθυνος», «θα προωθηθεί στο αρμόδιο τμήμα»). Κάθε απάντηση περνά ούτως ή άλλως από εσωτερικό ανθρώπινο έλεγχο — μην το διατυπώνεις ως υπόσχεση προς τον πελάτη. Αν η υπόθεση χρειάζεται ανθρώπινη κρίση, γράψε ουδέτερα: «θα εξετάσουμε το αίτημά σας και θα επανέλθουμε το συντομότερο».
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
    ctx.relatedContext &&
      `# Άλλες πρόσφατες συνομιλίες ΙΔΙΟΥ πελάτη (μόνο για context — ΜΗΝ τις ανακατεύεις στην απάντηση)\n${ctx.relatedContext}`,
    ctx.shopifyContext && `# Δεδομένα Shopify\n${ctx.shopifyContext}`,
    history && `# Πρόσφατα μηνύματα\n${history}`,
    `# Νέο μήνυμα πελάτη (προς απάντηση)\n${ctx.incomingMessage}`,
    ctx.attachmentSummary && `# Συνημμένα πελάτη\n${ctx.attachmentSummary}`,
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
    source: { type: "base64", media_type: img.mediaType, data: img.data },
  }));
  return [{ role: "user", content: [{ type: "text", text }, ...imageBlocks] }];
}
