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
        description: "Το πλήρες κείμενο της απάντησης προς τον πελάτη.",
      },
      promises_follow_up: {
        type: "boolean",
        description:
          "true αν η απάντηση ΔΕΝ επιλύει πλήρως το αίτημα τώρα αλλά υπόσχεται/υπονοεί ότι θα επανέλθουμε ΕΜΕΙΣ (π.χ. «θα το εξετάσουμε και θα επανέλθουμε», διερεύνηση με μεταφορική/3PL, αίτημα ακύρωσης/τροποποίησης που δεν επιβεβαιώνεται άμεσα). false αν η απάντηση είναι αυτοτελής και πλέον περιμένουμε τον πελάτη (ή δεν χρειάζεται τίποτα άλλο από εμάς).",
      },
      follow_up_action: {
        type: "string",
        description:
          "ΜΟΝΟ όταν promises_follow_up=true ή η υπόθεση θέλει ανθρώπινη ενέργεια/απόφαση: μια ΣΥΝΤΟΜΗ, ΕΣΩΤΕΡΙΚΗ περιγραφή της ενέργειας που πρέπει να κάνει ο συνεργάτης (ΟΧΙ προς τον πελάτη), με τα κρίσιμα στοιχεία — π.χ. «Άνοιξε case με DHL — παραγγελία #48647 (tracking 4725770696)» ή «Απόφαση goodwill/αποζημίωσης — πελάτης Lisa, #48647». Αλλιώς παράλειψέ το.",
      },
    },
    required: ["reply", "promises_follow_up"],
  },
};

/** Generates the customer-facing reply draft from the bounded context. */
export async function generateDraft(
  ctx: PromptContext,
): Promise<{ content: string; promisesFollowUp: boolean; followUpAction?: string }> {
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
      follow_up_action?: string;
    };
    return {
      content: (input.reply ?? "").trim(),
      promisesFollowUp: input.promises_follow_up === true,
      followUpAction: input.follow_up_action?.trim() || undefined,
    };
  }

  // Defensive fallback: if the model somehow returned plain text instead of the
  // tool call, treat that text as the reply (no follow-up assumed).
  const content = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();
  return { content, promisesFollowUp: false };
}
