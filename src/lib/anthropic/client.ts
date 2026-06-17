import Anthropic from "@anthropic-ai/sdk";
import { getEnv } from "../env";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY });
  }
  return client;
}

/** Verifies the API key and that the configured drafting model is reachable. */
export async function anthropicHealthCheck(): Promise<Record<string, unknown>> {
  const env = getEnv();
  const model = await anthropic().models.retrieve(env.ANTHROPIC_MODEL);
  return { model: model.id, displayName: model.display_name };
}
