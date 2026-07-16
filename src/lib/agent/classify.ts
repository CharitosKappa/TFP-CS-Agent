import { z } from "zod";
import { anthropic } from "../anthropic/client";
import { getEnv } from "../env";
import { errInfo, log } from "../observability/logger";
import { RED_LINE_RULES } from "./redlines";
import { INTENTS, type Classification } from "./types";

// Escalation categories the classifier detects semantically. Sourced from the
// red-line rules so keys stay in sync with the keyword backstop.
const ESCALATION_CATEGORIES = RED_LINE_RULES.map((r) => `  - ${r.key}: ${r.description}`).join("\n");

/**
 * Safe fallback when the triage model returns unparseable/invalid output.
 * confidence 0 is below the escalation threshold, so the draft is routed to a
 * human instead of crashing the whole pipeline.
 */
const FALLBACK_CLASSIFICATION: Classification = {
  intent: "other",
  confidence: 0,
  language: "el",
  sentiment: "neutral",
  summary: "(αυτόματη ταξινόμηση απέτυχε — χειρισμός από άνθρωπο)",
  // When unsure, assume a reply is needed (safer to draft than to silently close).
  requiresReply: true,
};

const ClassificationSchema = z.object({
  // `.catch("other")`: the model sometimes emits an escalation-reason key (e.g.
  // "order_modification") or another stray value here. Degrade to "other" instead
  // of failing the WHOLE classification — the escalation still fires via
  // escalationReasons/keywords, and we keep orderNumber and the rest.
  intent: z.enum(INTENTS).catch("other"),
  confidence: z.number().min(0).max(1),
  language: z.string().default("el"),
  // The triage model sometimes emits null / "" / a malformed value for an absent
  // optional field instead of omitting it. `.catch(undefined)` treats any such
  // per-field hiccup as "not present" so it never fails the whole classification
  // (which would needlessly drop us to the escalate-everything fallback).
  orderNumber: z.string().optional().catch(undefined),
  customerEmail: z.string().email().optional().catch(undefined),
  couponCode: z.string().optional().catch(undefined),
  productSize: z.string().optional().catch(undefined),
  productName: z.string().optional().catch(undefined),
  productSku: z.string().optional().catch(undefined),
  asksForReturnLabel: z.boolean().optional().catch(undefined),
  vendorPitch: z.boolean().optional().catch(undefined),
  escalationReasons: z.array(z.string()).optional().catch(undefined),
  sentiment: z.enum(["positive", "neutral", "negative"]).catch("neutral"),
  summary: z.string(),
  // Default/​fallback to true so an absent or malformed value never silently
  // suppresses a needed reply.
  requiresReply: z.boolean().default(true).catch(true),
});

const CLASSIFY_SYSTEM = `Είσαι ταξινομητής εισερχόμενων emails Customer Service για e-shop μόδας.
Διάβασε το μήνυμα και επέστρεψε ΜΟΝΟ ένα JSON αντικείμενο (χωρίς markdown, χωρίς επεξηγήσεις) με τα πεδία:
- intent: ένα από ${INTENTS.join(", ")}
- confidence: αριθμός 0..1 (πόσο σίγουρος είσαι για το intent)
- language: ISO κωδικός γλώσσας του μηνύματος (π.χ. "el", "en")
- orderNumber: ο αριθμός παραγγελίας αν αναφέρεται — ΚΑΙ στο «Θέμα:» (π.χ. "Order43605" → "43605") — αλλιώς παράλειψέ το. ΠΡΟΣΟΧΗ: αριθμός με πρόθεμα RMA (π.χ. "RMA5278") είναι αριθμός ΕΠΙΣΤΡΟΦΗΣ, ΟΧΙ παραγγελίας — ΜΗΝ τον δώσεις ποτέ ως orderNumber
- customerEmail: ΜΟΝΟ αν υπάρχει ΡΗΤΑ γραμμένη διεύθυνση email μέσα στο κείμενο του μηνύματος. ΜΗΝ την εφευρίσκεις και ΜΗΝ την παράγεις ποτέ από όνομα/υπογραφή (π.χ. «Stephanie Rougier» → ΟΧΙ «stephanie.rougier@…»). Αν δεν υπάρχει ρητό email, ΠΑΡΑΛΕΙΨΕ το πεδίο.
- couponCode: ο κωδικός έκπτωσης/κουπονιού αν αναφέρεται (π.χ. "erynn25"), αλλιώς παράλειψέ το
- productSize: το μέγεθος/νούμερο για το οποίο ρωτά ο πελάτης για ένα προϊόν, αν αναφέρεται (π.χ. "42"). Αλλιώς παράλειψέ το.
- productName: το όνομα/τίτλος του προϊόντος που αναφέρει ο πελάτης ΟΠΩΣ το γράφει (π.χ. "Σανδάλια Fisherman Flatform - Μόκα Σουέντ"), ΚΑΙ από το «Θέμα:» αν εκεί βρίσκεται. Χρήσιμο όταν ΔΕΝ δίνει σύνδεσμο προϊόντος. Αλλιώς παράλειψέ το.
- productSku: ο κωδικός προϊόντος (SKU/κωδικός χρώματος) που παραθέτει ο πελάτης — τυπικά 8ψήφιος (χρώμα) ή 11ψήφιος (παραλλαγή με μέγεθος), π.χ. "24037035". ΠΙΑΣΕ ΤΟΝ ΚΑΙ ΩΣ ΣΚΕΤΟ ΑΡΙΘΜΟ, χωρίς τη λέξη «SKU» μπροστά (π.χ. «24037035 ενδιαφέρομαι γι' αυτό» → "24037035"). ΜΗΝ τον μπερδεύεις με αριθμό παραγγελίας (5ψήφιος, ή με πρόθεμα «Order»/«#») ή τηλέφωνο (10ψήφιος). Αλλιώς παράλειψέ το.
- asksForReturnLabel: true ΜΟΝΟ αν ο πελάτης ζητά ρητά να ΛΑΒΕΙ ή να του ΞΑΝΑΣΤΑΛΕΙ την ετικέτα/voucher επιστροφής για τον courier (π.χ. «δεν βρίσκω το voucher», «στείλτε μου ξανά την ετικέτα επιστροφής», «πού είναι το συνοδευτικό αποστολής»). Αλλιώς παράλειψέ το.
- vendorPitch: true ΜΟΝΟ όταν ο αποστολέας ΔΕΝ είναι πελάτης αλλά τρίτος που κάνει ΑΖΗΤΗΤΗ B2B/εμπορική προσέγγιση — προμηθευτής/κατασκευαστής που προτείνει προϊόντα, χονδρική ή sourcing/dropshipping, ή agency που πουλά υπηρεσίες SEO/marketing/IT/κατασκευής site, επενδύσεις κ.λπ. (π.χ. κατάλογοι προϊόντων, «we can manufacture/supply», «boost your sales/traffic»). ΔΕΝ περιλαμβάνει αιτήματα τύπου/media/influencer ή προτάσεις brand-collaboration (αυτά ΔΕΝ είναι vendorPitch). Σε αμφιβολία, ή αν μοιάζει με πραγματικό πελάτη (παραγγελία/προϊόν/επιστροφή), ΑΦΗΣΕ το κενό.
- escalationReasons: πίνακας (array) με τα keys ΟΣΩΝ κατηγοριών ΙΣΧΥΟΥΝ, με βάση το ΝΟΗΜΑ του μηνύματος σε ΟΠΟΙΑΔΗΠΟΤΕ γλώσσα (κατάλαβε την πρόθεση — ΜΗ βασίζεσαι σε λέξεις-κλειδιά). Κενός πίνακας [] αν κανένα. Διαθέσιμα keys:
${ESCALATION_CATEGORIES}
- sentiment: positive | neutral | negative
- summary: μία πρόταση ΣΤΑ ΕΛΛΗΝΙΚΑ για το τι ζητάει ο πελάτης (εσωτερικό πεδίο — πάντα Ελληνικά, ανεξαρτήτως της γλώσσας του μηνύματος)
- requiresReply: true ΜΟΝΟ αν υπάρχει ΣΑΦΕΣ, ΕΝΕΡΓΟ αίτημα ή ερώτηση που περιμένει απάντηση ΤΩΡΑ. ΕΝΕΡΓΟ αίτημα είναι ΚΑΙ η αποστολή στοιχείων ΧΩΡΙΣ ερώτηση (ο πελάτης στέλνει διεύθυνση/φωτογραφίες/IBAN ή προωθεί ένα notification/απόδειξη): περιμένει να τα χρησιμοποιήσουμε ή να επιβεβαιώσουμε ότι τα λάβαμε → true. false αν το μήνυμα είναι ουσιαστικά κλείσιμο/ευχαριστία/επιβεβαίωση (π.χ. «ευχαριστώ πολύ!», «εντάξει, όλα καλά») — ΠΟΤΕ false απλώς επειδή το σώμα μοιάζει με αυτόματη ειδοποίηση (βλ. κανόνα (β) παρακάτω). ΠΡΟΣΟΧΗ: μια ευγενική/παθητική/ΥΠΟΘΕΤΙΚΗ ευχή σε ένα κατά τα άλλα μήνυμα-κλείσιμο (π.χ. «αν ποτέ έρθει ξανά stock, ενημερώστε με», «θα χαρώ να μάθω αν…», «καλή συνέχεια») ΔΕΝ είναι ενεργό αίτημα → requiresReply=false. Επίσης αν έχουμε ήδη απαντήσει στο ουσιαστικό αίτημα και ο πελάτης απλώς ευχαριστεί/κλείνει → false.

Δύο γενικοί κανόνες:
(α) Το «Θέμα:» είναι ΜΕΡΟΣ του μηνύματος — συχνά ο πελάτης γράφει το αίτημα ή την κρίσιμη πληροφορία ΜΟΝΟ εκεί (π.χ. θέμα «The Adress - Rua Andaluz 40 … Lisboa» = μας δίνει διεύθυνση παράδοσης). Αξιολόγησέ το ισότιμα με το σώμα σε intent/summary/requiresReply.
(β) Ό,τι ταξινομείς είναι ΠΑΝΤΑ μήνυμα που έστειλε ο πελάτης προς εμάς (support). Αν το σώμα μοιάζει με αυτόματη ειδοποίηση (π.χ. προωθημένο "Your order is on the way", tracking, απόδειξη), ο ΠΕΛΑΤΗΣ μάς την προώθησε για κάποιο λόγο — ΔΕΝ είναι «απλή ειδοποίηση» και ΔΕΝ σημαίνει requiresReply=false. Βρες το αίτημα στο Θέμα ή στα λίγα δικά του λόγια· αν ο λόγος δεν είναι σαφής, requiresReply=true (η απάντηση θα ζητήσει διευκρίνιση).`;

/**
 * Extracts the first BALANCED {...} object, tracking string literals so braces
 * inside string values don't count. Beats indexOf/lastIndexOf, which over-slice
 * when the model wraps the object in prose that itself contains braces.
 */
function firstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      if (--depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Strips ```json fences and returns the first JSON object found. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const obj = firstJsonObject(candidate);
  if (!obj) {
    throw new Error(`No JSON object in classifier output: ${text.slice(0, 200)}`);
  }
  return obj;
}

export async function classifyEmail(
  text: string,
  subject?: string,
): Promise<Classification> {
  const env = getEnv();
  // Include the subject — it often carries the order number (e.g. "Order43605").
  const content = subject?.trim() ? `Θέμα: ${subject.trim()}\n\n${text}` : text;
  const res = await anthropic().messages.create({
    model: env.ANTHROPIC_TRIAGE_MODEL,
    max_tokens: 1024,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: "user", content }],
  });

  const raw = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");

  // Never let a malformed model response crash drafting — fall back to a
  // low-confidence "other" so the red-line gate escalates it to a human.
  try {
    return ClassificationSchema.parse(JSON.parse(extractJson(raw))) as Classification;
  } catch (e) {
    log.warn("classify_parse_failed", errInfo(e));
    return { ...FALLBACK_CLASSIFICATION };
  }
}
