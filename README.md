# TFP Customer Service Agent

AI agent που λαμβάνει emails πελατών από το Customer Service (shared mailbox στο
Microsoft 365), τα αναλύει με γνώση των πολιτικών της TFP + δεδομένα Shopify, και
ετοιμάζει **draft απαντήσεις** που εγκρίνει/τροποποιεί/απορρίπτει ένας άνθρωπος μέσα
από ένα web dashboard. Κάποιες «κόκκινες γραμμές» πάντα παραπέμπονται σε άνθρωπο.

## Stack
- **Next.js (App Router) + TypeScript** — backend + review dashboard
- **PostgreSQL + Prisma** — conversations, messages, drafts, reviews, audit log
- **Microsoft Graph** — ανάγνωση/αποστολή/draft στο shared mailbox (app-only auth)
- **Shopify Admin API** — παραγγελίες, προϊόντα, πελάτες
- **Claude (Anthropic)** — classify (Haiku) + draft (Opus)

## Αρχιτεκτονική (modules)
```
src/lib/
  env.ts                 # validated env config
  db.ts                  # Prisma singleton
  anthropic/client.ts    # Claude client + health check
  graph/client.ts        # Microsoft Graph auth + fetch + health check
  shopify/client.ts      # Shopify Admin GraphQL + health check
  shopify/{orders,customers,products}.ts  # entity lookups
  shopify/context.ts     # gathers + formats Shopify data for the prompt
  knowledge/policies.ts  # loads cached policy text (all knowledge/*.md|txt)
  agent/
    types.ts             # Classification, PromptContext, DraftResult
    redlines.ts          # escalation rules + detector
    context.ts           # builds cached system + bounded messages
    classify.ts          # intent/entities/sentiment (triage model)
    draft.ts             # generates the reply draft
    summary.ts           # rolling case-summary updater
    pipeline.ts          # classify → Shopify → red-line gate → draft
    process.ts           # orchestrates: thread + summary → draft → persist
src/app/
  page.tsx               # dashboard landing (Phase 3)
  api/health/route.ts    # GET /api/health — pings all 3 services
knowledge/policies.md    # ⚠️ replace placeholders with real TFP policies
scripts/
  health-check.ts        # npm run health
  draft-sample.ts        # test the agent core on a sample email
```

## Bounded context — γιατί τα follow-ups μένουν φθηνά
Σε κάθε απάντηση το μοντέλο χρειάζεται το context της συνομιλίας, αλλά **δεν**
ξαναδιαβάζει αφελώς όλο το thread:
- **Policies** → ίδιο σε κάθε email, μπαίνει σε **cached system block** (~0.1× input cost).
- **Rolling case summary** (`Conversation.summary`) → συμπυκνωμένο, ενημερώνεται
  incrementally μετά από κάθε turn (βλ. `agent/summary.ts`).
- Μόνο τα **τελευταία 1–2 μηνύματα + το νέο μήνυμα + φρέσκα δεδομένα Shopify** ποικίλλουν.

Έτσι το κόστος ανά απάντηση μένει ~σταθερό, όσο κι αν μεγαλώσει η συνομιλία.
Η γνώση είναι μικρή/κλειστή → injection με caching αντί για RAG (το RAG μπαίνει
μόνο αν μεγαλώσει πολύ η γνωσιακή βάση).

## Setup

### 1. Dependencies
```bash
npm install
```

### 2. Environment
```bash
cp .env.example .env   # συμπληρώστε τις τιμές
```
- **Azure AD app registration** με **application** permissions `Mail.ReadWrite` +
  `Mail.Send` (admin consent). Συμπληρώστε `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
  `GRAPH_CLIENT_SECRET`, `GRAPH_MAILBOX` (π.χ. `support@thefashionproject.gr`).
- **Shopify Dev Dashboard custom app** → `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`
  (από Dev Dashboard › app › Settings) + `SHOPIFY_STORE_DOMAIN`. Το Admin API token
  παράγεται **runtime** μέσω OAuth `client_credentials` grant (βλ. `shopify/client.ts`)
  — δεν αποθηκεύεται στατικά. Προϋποθέσεις: app + store στον **ίδιο Dev Dashboard org**,
  scopes `read_orders`/`read_customers`/`read_products`/`read_discounts` (+ `read_price_rules`
  για legacy κωδικούς έκπτωσης) ρυθμισμένα, και app **installed**
  στο store (αλλιώς `shop_not_permitted`).
- **Anthropic** API key → `ANTHROPIC_API_KEY`.

### 3. Database
```bash
npm run prisma:generate
npm run prisma:migrate      # δημιουργεί τα tables
```

### 4. Έλεγχος
```bash
npm run health              # pings Anthropic + Graph + Shopify
npx tsx scripts/draft-sample.ts   # δοκιμή του agent core σε δείγμα email
npm run dev                 # http://localhost:3000  +  /api/health
```

### 5. Ingestion (Phase 1)
```bash
# manual pull από το inbox (δεν χρειάζεται webhook)
npm run ingest               # ή: npx tsx scripts/ingest.ts 50
# ή μέσω HTTP:  POST http://localhost:3000/api/ingest?limit=25

# webhook push (όταν υπάρχει public HTTPS URL):
npm run subscribe            # create | list | delete <id>
```
Το webhook endpoint είναι το `POST /api/graph/notifications` (κάνει validation
handshake + ingestion, επαληθεύει το `clientState`). Απαιτεί
`GRAPH_WEBHOOK_NOTIFICATION_URL` + `GRAPH_WEBHOOK_CLIENT_STATE`. Οι συνδρομές
λήγουν ~3 μέρες — χρειάζονται renewal (`renewSubscription`) με cron.

### 6. Drafting (Phase 2)
```bash
# δοκιμή agent core σε δείγμα email (χωρίς DB/mailbox):
npx tsx scripts/draft-sample.ts

# draft για όλα τα νέα inbound messages της βάσης:
npm run process                       # ή: npx tsx scripts/process.ts <messageId>
# ή μέσω HTTP:  POST http://localhost:3000/api/process?limit=10
# ή αλυσιδωτά με το sync:  POST /api/ingest?limit=25&draft=true
```
Κάθε draft αποθηκεύεται (status `PENDING`, με classification + escalation flags), η
περίληψη της συνομιλίας ενημερώνεται, και το status γίνεται `AWAITING_REVIEW` ή
`ESCALATED`. Συμπληρώστε τα `knowledge/*.md` με τις πραγματικές πολιτικές.

### 7. Review dashboard (Phase 3)
```bash
npm run dev          # http://localhost:3000
```
- **`/`** — ουρά ελέγχου: όλα τα drafts σε κατάσταση `PENDING`, με escalated πρώτα
  και μετά FIFO. Κάθε κάρτα δείχνει intent, βεβαιότητα, sentiment, κόκκινες γραμμές.
- **`/review/[conversationId]`** — όλη η συνομιλία (thread), το draft με το reasoning
  του agent, και ο editor. Ο ελεγκτής κάνει **Έγκριση** / **Αποθήκευση & έγκριση**
  (αν τροποποίησε το κείμενο) / **Απόρριψη**, με προαιρετική σημείωση.
- Κάθε ενέργεια γράφεται ως `Review` + `AuditLog` σε ένα transaction.
- Ταυτότητα ελεγκτή: από το **Entra ID session** (Phase 5) — βλ. §9.

### 8. Αποστολή & follow-ups (Phase 4)
- **Έγκριση & αποστολή** (ένα κλικ): το εγκεκριμένο/επεξεργασμένο draft στέλνεται στον
  πελάτη **μέσα στο ίδιο thread** (Graph `createReply` → set body → `send`). Απαιτεί
  Graph permission `Mail.Send`. Αν η αποστολή αποτύχει, το draft μένει `APPROVED`/`EDITED`
  και παραμένει στην ουρά με κουμπί **«Αποστολή»** για retry.
- Μετά την αποστολή: καταγράφεται OUTBOUND `Message`, το draft γίνεται `SENT`, η
  συνομιλία `AWAITING_CUSTOMER`, και η **rolling summary** ενημερώνεται με την απάντηση.
  Έτσι όταν απαντήσει ξανά ο πελάτης (νέο inbound → `ingest` + `process`), το νέο draft
  έχει **πλήρες context** (summary + πρόσφατα μηνύματα, μαζί με ό,τι στείλαμε).
- **Feedback loop στα rejects:** «Απόρριψη & ξαναγράψε» απορρίπτει το draft και παράγει
  νέο, περνώντας τη σημείωση του ελεγκτή ως **οδηγία διόρθωσης** στο prompt· «Απόρριψη
  (σε άνθρωπο)» απορρίπτει και βάζει τη συνομιλία σε `ESCALATED`.

### 9. Hardening (Phase 5)
**Auth (Entra ID SSO):** το dashboard + τα Server Actions προστατεύονται από
`src/middleware.ts` + `requireReviewer()`. Συμπληρώστε `AUTH_SECRET`,
`AUTH_MICROSOFT_ENTRA_ID_{ID,SECRET,ISSUER}` (μπορεί ίδιο tenant με το Graph),
προαιρετικά `ALLOWED_REVIEWERS`. Redirect URI στο Azure:
`<AUTH_URL>/api/auth/callback/microsoft-entra-id`. Η ταυτότητα του ελεγκτή
καταγράφεται από το session (όχι env).

**Machine routes:** `POST /api/ingest`, `POST /api/process` και το αναλυτικό
`GET /api/health` απαιτούν `INTERNAL_API_SECRET` (`Authorization: Bearer …` ή
`x-internal-secret`). Χωρίς το secret, το ingest/process επιστρέφουν 401 και το
health δίνει μόνο liveness. Ο webhook απαιτεί `GRAPH_WEBHOOK_CLIENT_STATE`
(fail-closed, timing-safe σύγκριση).

**Escalated send:** τα red-line drafts στέλνονται μόνο με υποχρεωτική
**αιτιολόγηση override** (καταγράφεται στο audit log).

**Send integrity:** atomic claim (`→ SENDING`) αποτρέπει διπλή αποστολή· οι
non-idempotent Graph κλήσεις (createReply/PATCH/send) **δεν** κάνουν retry. Αν μια
αποστολή στείλει αλλά αποτύχει η καταγραφή, το draft μένει `SENDING` (ορατό στην
ουρά ως «χρειάζεται έλεγχος») και ανακτάται με `npm run reconcile` (back-fill ή
επαναφορά για retry).

**Resilience/observability:** retries+timeouts σε Graph/Shopify/Anthropic,
fallback-σε-escalation αν αποτύχει η ταξινόμηση, structured JSON logs (PII-safe),
queue-depth metric στο `/api/health`.

**GDPR:** βλ. [PRIVACY.md](PRIVACY.md) — retention purge (`npm run retention`),
export/erase (`npm run gdpr export|erase <email>`), drop του `bodyHtml`, cascade
στο `AuditLog`.

> ⚠️ **Migration:** το schema άλλαξε (νέο `SENDING` status, αφαίρεση `bodyHtml`,
> `AuditLog → Conversation` cascade). Τρέξτε `npm run prisma:migrate` (ή
> `prisma db push`) πριν τη χρήση.

## Roadmap
- **Phase 0 — Scaffold & infra** ✅ (αυτό το commit): project, Prisma schema,
  clients + health checks, agent core skeleton.
- **Phase 1 — Ingestion & threading** ✅: Graph read shared mailbox → αποθήκευση
  conversations/messages (threading με `conversationId`), manual sync + webhook subscription.
- **Phase 2 — Agent core (bounded context) & knowledge** ✅: Shopify tools ανά
  intent (orders/customers/products), rolling summary wired στο draft pipeline,
  multi-file knowledge loader. (Pending: πραγματικό περιεχόμενο πολιτικών + PDF/Word ingest.)
- **Phase 3 — Red lines & review dashboard** ✅: queue (`/`), thread view +
  draft editor (`/review/[id]`), Approve/Edit/Reject μέσω Server Actions, audit
  log ανά συνομιλία. Δεν στέλνει ακόμα — η έγκριση απλώς μαρκάρει το draft
  `APPROVED` (η αποστολή είναι Phase 4). (Pending: auth → Phase 5.)
- **Phase 4 — Sending & follow-ups** ✅: αποστολή εγκεκριμένης απάντησης in-thread
  (Graph `createReply` → set body → `send`), καταγραφή OUTBOUND message + ενημέρωση
  rolling summary (ώστε τα follow-ups να έχουν πλήρες context αυτόματα), feedback
  loop στα rejects («ξαναγράψε» με την οδηγία του ελεγκτή ως guidance στο prompt).
- **Phase 5 — Hardening** ✅: Entra ID SSO + route/action auth, machine-route
  secret, escalation override gate, send-integrity (atomic claim, persist-before-
  summary, audit on failure), retries/timeouts στα external APIs, classify
  fallback, structured logging + queue-depth metric, GDPR retention/erasure/export
  + data minimization. (Βλ. §9 + [PRIVACY.md](PRIVACY.md).)
  Εκκρεμότητες για επόμενο γύρο: eval/regression set για classification & red-line
  recall, prompt tuning, async webhook processing, role separation reviewers.
