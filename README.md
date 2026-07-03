# TFP Customer Service Agent

AI agent που διαβάζει emails πελατών από το Customer Service (shared mailbox στο
Microsoft 365), τα αναλύει με γνώση των πολιτικών της TFP + δεδομένα από Shopify
και Odoo, και **αφήνει draft απαντήσεις μέσα στο Outlook** (φάκελος Drafts) για να
τις ελέγξει και να τις στείλει ένας άνθρωπος. Follow-ups και «κόκκινες γραμμές»
(escalations) καταγράφονται ως **tasks στο Microsoft Planner**, όπου ο συνεργάτης
αποφασίζει.

> **Λειτουργικό μοντέλο: η εφαρμογή ζει στο Outlook + Planner, όχι σε web UI.**
> Δεν υπάρχει dashboard ούτε βάση δεδομένων. Ο agent είναι δύο scripts + shared
> libs που τρέχουν με `tsx`. **Ποτέ δεν στέλνει email** — δημιουργεί μόνο drafts·
> ο άνθρωπος πατάει Send μέσα από το Outlook.

## Stack
- **TypeScript** (τρέχει με `tsx`, χωρίς web server/DB)
- **Microsoft Graph** (app-only) — ανάγνωση mailbox, δημιουργία Outlook drafts, Planner tasks
- **Shopify Admin API** — παραγγελίες, πελάτες, store credit, delivery estimates, εκπτωτικοί κωδικοί
- **Odoo** (self-hosted, read-only JSON-RPC) — RMA/επιστροφές, courier voucher
- **Claude (Anthropic)** — classify (Haiku) + draft (Opus)

## Ροή
1. Νέο εισερχόμενο φτάνει στο shared mailbox.
2. `unread-to-outlook-drafts` διαβάζει τα **αδιάβαστα**, μαζεύει context (thread από
   Graph, Shopify, Odoo), γράφει **draft απάντηση στο Outlook**. Αν είναι escalation,
   βάζει flag/category στο εισερχόμενο **και** δημιουργεί **Planner task**.
3. Ο άνθρωπος ελέγχει στο Outlook → στέλνει· τα escalations τα χειρίζεται στο Planner.
4. Όταν χρειάζεται follow-up (π.χ. εκπτωτικός κωδικός goodwill), ο άνθρωπος γράφει την
   απόφαση στο Planner task και το κλείνει. Το `process-followups` το εντοπίζει και
   γράφει **νέο draft** στο Outlook που κοινοποιεί την απόφαση (idempotent).

## Αρχιτεκτονική (modules)
```
scripts/
  unread-to-outlook-drafts.ts  # αδιάβαστα → Outlook drafts (+ escalation flag/Planner task)
  process-followups.ts         # Planner απόφαση → follow-up draft στο Outlook
  health-check.ts              # npm run health — pings Anthropic + Graph + Shopify + Odoo + Planner
src/lib/
  env.ts                       # validated env config (lazy)
  anthropic/client.ts          # Claude client
  graph/{client,messages,message-parse,planner,types}.ts  # Graph auth/fetch, drafts, Planner
  shopify/{client,context,orders,customers,discounts}.ts  # entity lookups + prompt context
  odoo/{client,context,rma,attachments}.ts                # RMA state + courier voucher
  knowledge/policies.ts        # φορτώνει τα knowledge/*.md (cached)
  ingestion/html.ts            # HTML→text (inbound) + formatReplyHtml (outgoing bold/bullets/font)
  media/{image,downscale}.ts   # vision: sniff/downscale εικόνων πελάτη
  agent/
    types.ts                   # Classification, PromptContext, DraftResult
    redlines.ts                # escalation rules + detector
    classify.ts                # intent/entities/sentiment (triage model)
    context.ts                 # cached system + bounded messages
    draft.ts                   # submit_reply tool → structured draft
    pipeline.ts                # classify → Shopify/Odoo → red-line gate → draft
    thread-context.ts          # thread + cross-thread ιστορικό απευθείας από Graph
    inbound-media.ts           # attachments πελάτη → vision + text summary
knowledge/*.md                 # οι πραγματικές πολιτικές TFP (per-market GR/CY/EU/UK)
```

## Bounded context — γιατί τα drafts μένουν φθηνά
- **Policies** → ίδιο σε κάθε email, μπαίνει σε **cached system block** (~0.1× input cost).
- Το **ιστορικό thread** (και cross-thread) τραβιέται **απευθείας από Graph** ανά draft —
  όχι από βάση — ώστε ο agent να μην είναι ποτέ τυφλός στο τι έχουμε ήδη πει.
- Η γνώση είναι μικρή/κλειστή → injection με caching αντί για RAG.

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
  `Mail.Send` + `Tasks.ReadWrite.All` (admin consent), scoped στο support mailbox
  μέσω Application Access Policy. → `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
  `GRAPH_CLIENT_SECRET`, `GRAPH_MAILBOX`, `PLANNER_PLAN_ID` (+ προαιρετικά `PLANNER_BUCKET_ID`).
- **Shopify Dev Dashboard custom app** → `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`
  + `SHOPIFY_STORE_DOMAIN`. Το Admin API token παράγεται runtime μέσω OAuth
  `client_credentials` (βλ. `shopify/client.ts`). Scopes: `read_orders`,
  `read_customers`, `read_products`, `read_discounts`, `read_price_rules`,
  `read_store_credit_accounts`, `read_*_fulfillment_orders`.
- **Odoo** read-only user + API key → `ODOO_URL`, `ODOO_DB`, `ODOO_API_USER`, `ODOO_API_KEY`.
- **Anthropic** → `ANTHROPIC_API_KEY`.

### 3. Έλεγχος
```bash
npm run health     # pings Anthropic + Graph + Shopify + Odoo + Planner
```

## Χρήση
```bash
# Διάβασε τα αδιάβαστα και άφησε drafts στο Outlook (προαιρετικό όριο):
npm run drafts            # ή: npx tsx scripts/unread-to-outlook-drafts.ts 20

# Μετά την απόφαση σε κλεισμένα Planner tasks, γράψε τα follow-up drafts:
npm run followups         # ή: npx tsx scripts/process-followups.ts
```
Και τα δύο scripts **μόνο** δημιουργούν drafts — δεν στέλνουν ποτέ. Το «draft-only
test mode» είναι εγγενές: τρέξε τα, δες τα drafts στον φάκελο **Drafts** του Outlook
και τα escalations flagged + ως tasks στο Planner, και στείλε ό,τι εγκρίνεις χειροκίνητα.

## Deployment / scheduling
Τα δύο scripts προορίζονται να τρέχουν περιοδικά (π.χ. **cron** κάθε 2–5 λεπτά) στο
host που θα επιλεγεί. Δεν υπάρχει web server να συντηρηθεί. Το Odoo είναι σε ιδιωτικό
δίκτυο → αν το host είναι στο cloud, χρειάζεται ασφαλής πρόσβαση (π.χ. Cloudflare
Tunnel). Real-time webhook αντί για polling παραμένει μελλοντική επιλογή.

## Privacy
Βλ. [PRIVACY.md](PRIVACY.md). Ο agent είναι **stateless** (χωρίς βάση) — τα δεδομένα
ζουν στο Microsoft 365 (mailbox/Planner)· η διατήρηση διέπεται από τις πολιτικές του M365.
