import { z } from "zod";
import { anthropic } from "../anthropic/client";
import { getEnv } from "../env";
import { INTENTS, type Classification } from "./types";

const ClassificationSchema = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
  language: z.string().default("el"),
  orderNumber: z.string().optional(),
  customerEmail: z.string().email().optional(),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  summary: z.string(),
});

const CLASSIFY_SYSTEM = `Είσαι ταξινομητής εισερχόμενων emails Customer Service για e-shop μόδας.
Διάβασε το μήνυμα και επέστρεψε ΜΟΝΟ ένα JSON αντικείμενο (χωρίς markdown, χωρίς επεξηγήσεις) με τα πεδία:
- intent: ένα από ${INTENTS.join(", ")}
- confidence: αριθμός 0..1 (πόσο σίγουρος είσαι για το intent)
- language: ISO κωδικός γλώσσας του μηνύματος (π.χ. "el", "en")
- orderNumber: ο αριθμός παραγγελίας αν αναφέρεται, αλλιώς παράλειψέ το
- customerEmail: email αν αναφέρεται, αλλιώς παράλειψέ το
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

export async function classifyEmail(text: string): Promise<Classification> {
  const env = getEnv();
  const res = await anthropic().messages.create({
    model: env.ANTHROPIC_TRIAGE_MODEL,
    max_tokens: 1024,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: "user", content: text }],
  });

  const raw = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  const parsed = ClassificationSchema.parse(JSON.parse(extractJson(raw)));
  return parsed as Classification;
}
