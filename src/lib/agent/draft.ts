import { anthropic } from "../anthropic/client";
import { getEnv } from "../env";
import { buildMessages, buildSystemBlocks } from "./context";
import type { PromptContext } from "./types";

/** Generates the customer-facing reply draft from the bounded context. */
export async function generateDraft(
  ctx: PromptContext,
): Promise<{ content: string }> {
  const env = getEnv();
  const res = await anthropic().messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 2000,
    system: buildSystemBlocks(ctx),
    messages: buildMessages(ctx),
  });

  const content = res.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n")
    .trim();

  return { content };
}
