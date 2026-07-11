import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../anthropic/client";
import { getEnv } from "../env";
import { buildMessages, buildSystemBlocks } from "./context";
import type { PromptContext } from "./types";

/**
 * The model submits its reply through this tool rather than as free text, so we
 * get the reply AND a machine-readable `promises_follow_up` flag in one call —
 * works in ANY reply language because the model (not a phrase matcher) decides
 * whether it deferred. tool_choice forces it, so every draft is structured.
 */
const SUBMIT_REPLY_TOOL: Anthropic.Tool = {
  name: "submit_reply",
  description:
    "Υποβάλλει την τελική απάντηση προς τον πελάτη μαζί με το αν αυτή υπόσχεται/υπονοεί μελλοντικό follow-up από εμάς.",
  input_schema: {
    type: "object",
    properties: {
      reply: {
        type: "string",
        description:
          "Το πλήρες κείμενο της απάντησης προς τον πελάτη. Χρησιμοποίησε απλή μορφοποίηση: κενή γραμμή ανάμεσα σε παραγράφους· **έντονα** για έμφαση (π.χ. εκπτωτικοί κωδικοί)· γραμμές που ξεκινούν με «- » για λίστες/όρους. Μη βάζεις HTML.",
      },
      promises_follow_up: {
        type: "boolean",
        description:
          "true αν η απάντηση ΔΕΝ επιλύει πλήρως το αίτημα τώρα αλλά υπόσχεται/υπονοεί ότι θα επανέλθουμε ΕΜΕΙΣ (π.χ. «θα το εξετάσουμε και θα επανέλθουμε», διερεύνηση με μεταφορική/3PL, αίτημα ακύρωσης/τροποποίησης που δεν επιβεβαιώνεται άμεσα). false αν η απάντηση είναι αυτοτελής και πλέον περιμένουμε τον πελάτη (ή δεν χρειάζεται τίποτα άλλο από εμάς).",
      },
      needs_human_answer: {
        type: "boolean",
        description:
          "true ΜΟΝΟ όταν ο πελάτης κάνει μια ΣΥΓΚΕΚΡΙΜΕΝΗ ερώτηση (συνήθως για προϊόν/τεχνικό χαρακτηριστικό — π.χ. αν λυγίζει η σόλα, πόσο ψηλό είναι το τακούνι, υφή/υλικό) την οποία ΔΕΝ μπορείς να απαντήσεις από τα δεδομένα/τη γνώση που σου δόθηκαν, οπότε η απάντησή σου απλώς αναβάλλει («θα το εξετάσουμε»). Τότε το θέμα χρειάζεται ΑΝΘΡΩΠΟ με γνώση προϊόντος να απαντήσει (με βάση αυτό το draft). false όταν απάντησες πλήρως το ερώτημα από τα δεδομένα/γνώση, ή όταν η αναβολή αφορά ενέργεια (π.χ. έρευνα courier, απόφαση) και όχι έλλειψη πληροφορίας.",
      },
      follow_up_title: {
        type: "string",
        description:
          "ΜΟΝΟ όταν χρειάζεται follow-up/ανθρώπινη ενέργεια: ΠΟΛΥ σύντομη ουσία της ενέργειας (≤ 6 λέξεις, ΧΩΡΙΣ αριθμό παραγγελίας/όνομα — μπαίνουν αυτόματα), π.χ. «Απόφαση goodwill», «Έρευνα DHL», «Επιστροφή χρημάτων IBAN», «Ακύρωση παραγγελίας». Αλλιώς παράλειψέ το.",
      },
      follow_up_details: {
        type: "string",
        description:
          "ΜΟΝΟ όταν χρειάζεται follow-up: ΑΝΑΛΥΤΙΚΑ τι πρέπει να αποφασιστεί ή να γίνει από τον συνεργάτη (εσωτερικό, ΟΧΙ προς τον πελάτη) — το ερώτημα/απόφαση, τα κρίσιμα στοιχεία, τι ζητά ο πελάτης, και τυχόν προτεινόμενες επιλογές. 1-4 σύντομες προτάσεις.",
      },
    },
    required: ["reply", "promises_follow_up"],
  },
};

/** Generates the customer-facing reply draft from the bounded context. */
export async function generateDraft(
  ctx: PromptContext,
): Promise<{ content: string; promisesFollowUp: boolean; needsHumanAnswer: boolean; followUpTitle?: string; followUpDetails?: string }> {
  const env = getEnv();
  const res = await anthropic().messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 2000,
    system: buildSystemBlocks(ctx),
    messages: buildMessages(ctx),
    tools: [SUBMIT_REPLY_TOOL],
    tool_choice: { type: "tool", name: "submit_reply" },
  });

  const toolUse = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (toolUse) {
    const input = toolUse.input as {
      reply?: string;
      promises_follow_up?: boolean;
      needs_human_answer?: boolean;
      follow_up_title?: string;
      follow_up_details?: string;
    };
    return {
      content: (input.reply ?? "").trim(),
      promisesFollowUp: input.promises_follow_up === true,
      needsHumanAnswer: input.needs_human_answer === true,
      followUpTitle: input.follow_up_title?.trim() || undefined,
      followUpDetails: input.follow_up_details?.trim() || undefined,
    };
  }

  // Defensive fallback: if the model somehow returned plain text instead of the
  // tool call, treat that text as the reply (no follow-up assumed).
  const content = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
  return { content, promisesFollowUp: false, needsHumanAnswer: false };
}
