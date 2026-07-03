# Data Privacy & GDPR — TFP Customer Service Agent

The agent processes customer personal data (email addresses, names, and the
contents of customer emails). This document records what is processed, why, and
how data-subject rights are honored. Treat it as the working privacy notice for
the tool; the legal/retention values must be confirmed by TFP's DPO.

## Where data lives
The agent is **stateless — it has no database of its own.** It reads customer
mail from the Microsoft 365 shared mailbox, gathers context from Shopify/Odoo,
and writes its output back into Microsoft 365 (an Outlook **draft** reply, plus a
**Planner task** for follow-ups/escalations). All persistent customer data
therefore lives in **Microsoft 365** (and the source systems Shopify/Odoo), whose
retention, access control and erasure are governed by TFP's existing M365/Shopify/
Odoo policies and DPAs — not by this tool.

| Data | Where it lives |
|------|----------------|
| Customer email, name, message body | Microsoft 365 mailbox (Outlook) |
| AI draft reply | Outlook **Drafts** folder (until a human sends or discards it) |
| Follow-up / escalation notes | Microsoft Planner task |
| Order / customer / RMA lookups | Shopify + Odoo (read-only; not copied out) |

## Sub-processors
Customer message content is sent to:
- **Anthropic (Claude)** — classification, drafting (email text + attached images).
- **Microsoft Graph** — reading mail, creating drafts, creating Planner tasks (the
  data is already in M365).
- **Shopify Admin API** — order/customer lookups (order numbers, emails).
- **Odoo** (self-hosted, TFP-controlled) — RMA/order lookups.

Ensure DPAs are in place with Anthropic, Microsoft and Shopify and that this is
reflected in TFP's records of processing and customer-facing privacy policy.

## Retention & data-subject requests
Because the agent stores nothing itself, retention and DSARs (access / export /
erasure, GDPR Art. 15/17/20) are served **from Microsoft 365, Shopify and Odoo**
using their native tooling and TFP's existing DPO processes. There is no separate
purge/export script in this repo.

## Notes / limitations
- Copies that already left to sub-processors (e.g. model providers' transient
  logs) are governed by their own retention; rely on the DPAs above.
- GDPR/erasure mentions in inbound email are flagged as a **red line** so a human
  handles them via a Planner escalation (see `src/lib/agent/redlines.ts`).
