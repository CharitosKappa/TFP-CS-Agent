import { getEnv } from "../env";
import { htmlToText, stripQuotedReply } from "../ingestion/html";
import type { GraphMessage } from "./types";

/** Plain, quote-stripped text of a Graph message (HTML decoded when needed). */
export function toBodyText(msg: GraphMessage): string {
  const raw = msg.body?.content ?? msg.bodyPreview ?? "";
  const isHtml = (msg.body?.contentType ?? "").toLowerCase() === "html";
  return stripQuotedReply(isHtml ? htmlToText(raw) : raw);
}

/**
 * Returns a predicate for "is this address one of ours". "Us" = the mailbox's
 * own domain (support@, info@, …) plus any configured alias domain
 * (INTERNAL_EMAIL_DOMAINS) — so a reply from a sibling address isn't mistaken
 * for the customer. The customer is the first EXTERNAL participant.
 */
export function makeIsInternal(): (email: string) => boolean {
  const env = getEnv();
  const mailboxDomain = env.GRAPH_MAILBOX.toLowerCase().split("@")[1] ?? "";
  const internalDomains = new Set(
    [mailboxDomain, ...(env.INTERNAL_EMAIL_DOMAINS ?? "").split(",")]
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  );
  return (email: string) => {
    const at = email.lastIndexOf("@");
    return at !== -1 && internalDomains.has(email.slice(at + 1));
  };
}
