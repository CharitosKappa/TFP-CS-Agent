# Data Privacy & GDPR — TFP Customer Service Agent

The agent processes customer personal data (email addresses, names, and the
contents of customer emails). This document records what is stored, why, and how
data-subject rights are honored. Treat it as the working privacy notice for the
tool; the legal/retention values must be confirmed by TFP's DPO.

## What is stored (and where)
| Data | Table | Purpose |
|------|-------|---------|
| Customer email, name | `Conversation` | Threading + replying to the customer |
| Email subject, **plain-text** body | `Message` | Context for drafting + review |
| AI draft + classification + reasoning | `Draft` | Human review |
| Reviewer decisions + notes | `Review` | Accountability |
| Rolling case summary | `Conversation.summary` | Bounded context for follow-ups |
| Action trail | `AuditLog` | Audit / accountability |

**Data minimization:** the raw HTML body is intentionally **not** stored — only
the cleaned plain text (`Message.bodyText`) the agent and reviewers actually use.

## Sub-processors
Customer message content is sent to:
- **Anthropic (Claude)** — classification, drafting, summarization.
- **Microsoft Graph** — reading/sending mail (the data is already in M365).
- **Shopify Admin API** — order/customer lookups (order numbers, emails).

Ensure DPAs are in place with each and that this is reflected in TFP's records of
processing and customer-facing privacy policy.

## Retention
Conversations are purged after a configurable window of inactivity
(`RETENTION_DAYS`, default 730 days — set to TFP's policy). Deletes cascade to all
messages, drafts, reviews and audit logs.

```bash
npm run retention -- --dry-run     # report what would be deleted
npm run retention                  # purge using RETENTION_DAYS
npm run retention -- --days 365    # override the window
```
Schedule this (e.g. a daily cron / scheduled job) so retention is enforced
automatically.

## Data-subject requests (DSAR)
```bash
npm run gdpr export <email>   # Art.15/20 — export everything stored for a customer (JSON)
npm run gdpr erase  <email>   # Art.17 — permanently delete all of a customer's data
```
Erasure cascades across conversations, messages, drafts, reviews and audit logs.

## Notes / limitations
- Erasure/retention act on data in this system only — copies that already left to
  sub-processors (e.g. model providers' transient logs) are governed by their own
  retention; rely on the DPAs above.
- There is no automated DSAR intake; requests are run manually via the scripts.
- GDPR/erasure mentions in inbound email are also flagged as a red line so a human
  handles them (see `src/lib/agent/redlines.ts`).
