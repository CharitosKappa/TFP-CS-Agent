// Shopify "new contact form message" notifications arrive FROM a Shopify mailer
// address, with the real customer (name / email / message) in the body — e.g.:
//
//   Λάβατε ένα νέο μήνυμα από τη φόρμα επικοινωνίας ...
//   Ονομα: Ελένη
//   Επώνυμο: Αλεξοπούλου
//   Email: ellie@example.com
//   Message: <the customer's actual message>
//
// We parse it so the conversation is attributed to the customer, not the mailer.
// Field LABELS are localized (EL/EN/ES seen) but Shopify keeps "Email:" and
// "Message:" in English across languages, so we anchor on those + the first email.

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
  return (
    /@shopify\.com$/i.test(fromEmail) && MESSAGE_RE.test(body) && EMAIL_RE.test(body)
  );
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
