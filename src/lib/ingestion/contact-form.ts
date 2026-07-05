// Shopify "new contact form message" notifications arrive FROM a Shopify mailer
// address, with the real customer (name / email / message) in the body — e.g.:
//
//   You received a new message from your online store's contact form.
//   First Name: Bogna
//   Last Name: Schmidt
//   Email: bhakti291@gmail.com
//   Message: <the customer's actual message>
//
// The real customer is also in the Reply-To header (preferred). We parse this so
// the reply is drafted TO the customer (as a NEW email), not to the Shopify mailer.
// Field LABELS are localized (EL/EN/ES seen) but Shopify keeps "Email:" and
// "Message:" in English across languages, so we anchor on those + the first email.

import { normalizeLang } from "../util/lang";

export interface ContactFormSubmission {
  email: string;
  name: string | null;
  message: string;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const FIRST_NAME_RE = /(?:^|\n)[ \t]*(?:First Name|Όνομα|Ονομα|Nombre)[ \t]*:[ \t]*(.+)/i;
const LAST_NAME_RE = /(?:^|\n)[ \t]*(?:Last Name|Επώνυμο|Apellidos)[ \t]*:[ \t]*(.+)/i;
// Shopify sends the "Message:" label untranslated; everything after it is the body.
const MESSAGE_RE = /(?:^|\n)[ \t]*Message[ \t]*:[ \t]*([\s\S]*)$/;

/** Is this a Shopify contact-form notification (real customer hidden in the body)? */
export function isShopifyContactForm(fromEmail: string, body: string): boolean {
  return /@shopify\.com$/i.test(fromEmail) && MESSAGE_RE.test(body) && EMAIL_RE.test(body);
}

/** Extract the real customer + their message from a contact-form notification body. */
export function parseShopifyContactForm(body: string): ContactFormSubmission | null {
  const email = body.match(EMAIL_RE)?.[0]?.toLowerCase();
  if (!email) return null;
  const first = body.match(FIRST_NAME_RE)?.[1]?.trim();
  const last = body.match(LAST_NAME_RE)?.[1]?.trim();
  const name = [first, last].filter(Boolean).join(" ") || null;
  const message = body.match(MESSAGE_RE)?.[1]?.trim() || body.trim();
  return { email, name, message };
}

// Subject for the fresh reply email (there's no thread to inherit one from),
// localized to the customer's language; English fallback.
const SUBJECTS: Record<string, string> = {
  el: "Σχετικά με το μήνυμά σας — The Fashion Project",
  en: "Re: your message to The Fashion Project",
  de: "Ihre Nachricht an The Fashion Project",
  fr: "Votre message à The Fashion Project",
  it: "Il tuo messaggio a The Fashion Project",
  es: "Tu mensaje a The Fashion Project",
  nl: "Uw bericht aan The Fashion Project",
  pt: "A sua mensagem para The Fashion Project",
};

export function contactFormSubject(language?: string): string {
  return SUBJECTS[normalizeLang(language)] ?? SUBJECTS.en;
}

// Header above the quoted original message in a fresh contact-form reply.
const ORIGINAL_HEADERS: Record<string, string> = {
  el: "Το αρχικό σας μήνυμα:",
  en: "Your original message:",
  fr: "Votre message d'origine :",
  de: "Ihre ursprüngliche Nachricht:",
  it: "Il tuo messaggio originale:",
  es: "Tu mensaje original:",
  nl: "Uw oorspronkelijke bericht:",
  pt: "A sua mensagem original:",
};

export function originalMessageHeader(language?: string): string {
  return ORIGINAL_HEADERS[normalizeLang(language)] ?? ORIGINAL_HEADERS.en;
}
