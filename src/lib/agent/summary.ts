import { anthropic } from "../anthropic/client";
import { getEnv } from "../env";

const SUMMARY_SYSTEM = `Διατηρείς μια ΣΥΜΠΥΚΝΩΜΕΝΗ περίληψη μιας υπόθεσης Customer Service.
Σου δίνεται η προηγούμενη περίληψη και το νέο μήνυμα/ενέργεια. Επέστρεψε ΜΟΝΟ τη νέα,
ενημερωμένη περίληψη (όχι markdown, χωρίς εισαγωγικά). Κράτα: αριθμό παραγγελίας, το πρόβλημα,
τι έχουμε υποσχεθεί/απαντήσει, ανοιχτές ενέργειες, διάθεση πελάτη. Μέγιστο ~120 λέξεις.`;

/**
 * Folds a new turn into the rolling case summary. Only the new turn is
 * processed (not the whole thread), so this stays cheap as the thread grows.
 */
export async function updateCaseSummary(
  previousSummary: string,
  turn: { direction: "INBOUND" | "OUTBOUND"; body: string },
): Promise<string> {
  const env = getEnv();
  const speaker = turn.direction === "INBOUND" ? "Πελάτης" : "Εμείς";
  const res = await anthropic().messages.create({
    model: env.ANTHROPIC_TRIAGE_MODEL,
    max_tokens: 512,
    system: SUMMARY_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `# Προηγούμενη περίληψη\n${previousSummary || "(καμία ακόμη)"}\n\n` +
          `# Νέο μήνυμα\n[${speaker}] ${turn.body}`,
      },
    ],
  });

  return res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}
