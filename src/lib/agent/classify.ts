import { z } from "zod";
import { anthropic } from "../anthropic/client";
import { getEnv } from "../env";
import { errInfo, log } from "../observability/logger";
import { INTENTS, type Classification } from "./types";

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
};

const ClassificationSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  language: z.string().default("el"),
  orderNumber: z.string().optional(),
  customerEmail: z.string().email().optional(),
  couponCode: z.string().optional(),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  summary: z.string(),
});

const CLASSIFY_SYSTEM = `Είσαι ταξινομητής εισερχόμενων emails Customer Service για e-shop μόδας.
Διάβασε το μήνυμα και επέστρεψε ΜΟΝΟ ένα JSON αντικείμενο (χωρίς markdown, χωρίς επεξηγήσεις) με τα πεδία:
- intent: ένα από ${INTENTS.join(", ")}
- confidence: αριθμός 0..1 (πόσο σίγουρος είσαι για το intent)
- language: ISO κωδικός γλώσσας του μηνύματος (π.χ. "el", "en")
- orderNumber: ο αριθμός παραγγελίας αν αναφέρεται — ΚΑΙ στο «Θέμα:» (π.χ. "Order43605" → "43605") — αλλιώς παράλειψέ το
- customerEmail: email αν αναφέρεται, αλλιώς παράλειψέ το
- couponCode: ο κωδικός έκπτωσης/κουπονιού αν αναφέρεται (π.χ. "erynn25"), αλλιώς παράλειψέ το
- sentiment: positive | neutral | negative
- summary: μία πρόταση για το τι ζητάει ο πελάτης`;

/** Strips ```json fences and returns the first JSON object found. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`No JSON object in classifier output: ${text.slice(0, 200)}`);
  }
  return candidate.slice(start, end + 1);
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
