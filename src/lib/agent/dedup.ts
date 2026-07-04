import { anthropic } from "../anthropic/client";
import { getEnv } from "../env";
import { errInfo, log } from "../observability/logger";

/**
 * LLM judgment for a set of messages FROM THE SAME customer: are they the SAME
 * underlying request/issue — so one consolidated reply covers them all — or
 * genuinely distinct requests?
 *
 * Deliberately CONSERVATIVE: returns false (treat as distinct) on <2 messages,
 * on any doubt, or on error. Folding two messages together suppresses one draft,
 * so a wrong "SAME" would drop a real, separate customer request — worse than a
 * duplicate draft. We only consolidate when the model is clearly confident.
 */
export async function judgeSameRequest(
  messages: { subject?: string; body: string }[],
): Promise<boolean> {
  if (messages.length < 2) return false;
  const env = getEnv();
  const list = messages
    .map((m, i) => `[Μήνυμα ${i + 1}] Θέμα: ${m.subject ?? "(κανένα)"}\n${m.body.slice(0, 2000)}`)
    .join("\n\n---\n\n");
  try {
    const res = await anthropic().messages.create({
      model: env.ANTHROPIC_TRIAGE_MODEL,
      max_tokens: 8,
      system:
        "Σου δίνονται μηνύματα από τον ΙΔΙΟ πελάτη. Απάντησε ΜΟΝΟ με μία λέξη: " +
        "'SAME' αν αφορούν το ΙΔΙΟ ζήτημα και το ΙΔΙΟ αίτημα (μία απάντηση θα κάλυπτε " +
        "και τα δύο), ή 'DIFF' αν είναι διαφορετικά/ανεξάρτητα αιτήματα. Αν έχεις " +
        "αμφιβολία, απάντησε 'DIFF'. Καμία άλλη λέξη.",
      messages: [{ role: "user", content: list }],
    });
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim()
      .toUpperCase();
    return text.startsWith("SAME");
  } catch (e) {
    log.error("dedup_judge_failed", errInfo(e));
    return false; // fail safe: treat as distinct, never fold
  }
}
