import "dotenv/config";
import { prisma } from "../src/lib/db";

// Local-only sample data so the dashboard has something to show. Idempotent:
// wipes any prior 'seed-*' conversations first. NOT for production.
async function main() {
  await prisma.conversation.deleteMany({
    where: { graphConversationId: { startsWith: "seed-" } },
  });

  // 1) Normal pending draft — order status.
  const a = await prisma.conversation.create({
    data: {
      graphConversationId: "seed-a",
      subject: "Πού είναι η παραγγελία μου;",
      customerEmail: "maria.p@example.com",
      customerName: "Μαρία Παπαδοπούλου",
      status: "AWAITING_REVIEW",
      summary: "Η πελάτισσα ρωτά για την παραγγελία #1023, 10 μέρες σε αναμονή.",
      messages: {
        create: {
          graphMessageId: "seed-a-m1",
          direction: "INBOUND",
          fromEmail: "maria.p@example.com",
          toEmails: ["support@thefashionproject.gr"],
          bodyText:
            "Καλησπέρα σας, έχω κάνει την παραγγελία #1023 εδώ και 10 μέρες και δεν έχω λάβει κάτι. Μπορείτε να μου πείτε πού βρίσκεται;",
          receivedAt: new Date(),
        },
      },
    },
    include: { messages: true },
  });
  await prisma.draft.create({
    data: {
      conversationId: a.id,
      triggerMessageId: a.messages[0].id,
      status: "PENDING",
      content:
        "Αγαπητή κ. Παπαδοπούλου,\n\nσας ευχαριστούμε που επικοινωνήσατε. Εντοπίσαμε την παραγγελία #1023· βρίσκεται προς αποστολή και θα παραδοθεί εντός 2–3 εργάσιμων. Θα λάβετε αριθμό αποστολής μόλις φύγει από την αποθήκη.\n\nΜε εκτίμηση,\nΟμάδα Εξυπηρέτησης — The Fashion Project",
      reasoning: "intent=order_status confidence=0.82 sentiment=negative escalate=false",
      isEscalated: false,
      escalationReasons: [],
      classification: {
        intent: "order_status",
        confidence: 0.82,
        language: "el",
        orderNumber: "1023",
        sentiment: "negative",
        summary: "Πελάτισσα ρωτά για καθυστερημένη παραγγελία #1023.",
      },
    },
  });
  await prisma.auditLog.create({
    data: { conversationId: a.id, actor: "agent", action: "draft_created", detail: { intent: "order_status" } },
  });

  // 2) Escalated (red line) pending draft — legal threat.
  const b = await prisma.conversation.create({
    data: {
      graphConversationId: "seed-b",
      subject: "Επιστροφή χρημάτων — τελευταία προειδοποίηση",
      customerEmail: "g.nikolaou@example.com",
      customerName: "Γιώργος Νικολάου",
      status: "ESCALATED",
      summary: "Ο πελάτης απειλεί με νομικές ενέργειες αν δεν γίνει επιστροφή χρημάτων.",
      messages: {
        create: {
          graphMessageId: "seed-b-m1",
          direction: "INBOUND",
          fromEmail: "g.nikolaou@example.com",
          toEmails: ["support@thefashionproject.gr"],
          bodyText:
            "Αν δεν λάβω επιστροφή των χρημάτων μου άμεσα, θα κινηθώ νομικά μέσω δικηγόρου και θα κάνω καταγγελία.",
          receivedAt: new Date(),
        },
      },
    },
    include: { messages: true },
  });
  await prisma.draft.create({
    data: {
      conversationId: b.id,
      triggerMessageId: b.messages[0].id,
      status: "PENDING",
      content:
        "Αγαπητέ κ. Νικολάου,\n\nλυπούμαστε για την ταλαιπωρία. Το αίτημά σας προωθείται άμεσα σε αρμόδιο συνάδελφο που θα αναλάβει την υπόθεση και θα επικοινωνήσει μαζί σας.\n\nΜε εκτίμηση,\nΟμάδα Εξυπηρέτησης — The Fashion Project",
      reasoning: "intent=returns_refunds confidence=0.71 sentiment=negative escalate=true reasons=legal",
      isEscalated: true,
      escalationReasons: ["legal"],
      classification: {
        intent: "returns_refunds",
        confidence: 0.71,
        language: "el",
        sentiment: "negative",
        summary: "Πελάτης απειλεί με νομικές ενέργειες για επιστροφή χρημάτων.",
      },
    },
  });
  await prisma.auditLog.create({
    data: { conversationId: b.id, actor: "agent", action: "draft_created", detail: { intent: "returns_refunds", escalated: true, reasons: ["legal"] } },
  });

  // 3) Already sent — shows the thread with an outbound reply + audit trail.
  const c = await prisma.conversation.create({
    data: {
      graphConversationId: "seed-c",
      subject: "Ερώτηση για μέγεθος",
      customerEmail: "eleni.k@example.com",
      customerName: "Ελένη Κ.",
      status: "AWAITING_CUSTOMER",
      summary: "Απαντήσαμε σε ερώτηση για μέγεθος φορέματος· αναμονή πελάτη.",
      messages: {
        create: [
          {
            graphMessageId: "seed-c-m1",
            direction: "INBOUND",
            fromEmail: "eleni.k@example.com",
            toEmails: ["support@thefashionproject.gr"],
            bodyText: "Καλημέρα! Το φόρεμα Aria σε Medium είναι κανονικός γαλλικός;",
            receivedAt: new Date(Date.now() - 3600_000),
          },
          {
            graphMessageId: "seed-c-m2",
            direction: "OUTBOUND",
            fromEmail: "support@thefashionproject.gr",
            toEmails: ["eleni.k@example.com"],
            bodyText:
              "Καλημέρα Ελένη,\n\nτο φόρεμα Aria έχει κανονική εφαρμογή· για Medium προτείνουμε μεγέθη 40–42. Αν θέλετε πιο άνετη εφαρμογή, επιλέξτε Large.\n\nΜε εκτίμηση,\nΟμάδα Εξυπηρέτησης — The Fashion Project",
            receivedAt: new Date(Date.now() - 1800_000),
          },
        ],
      },
    },
    include: { messages: true },
  });
  const sentDraft = await prisma.draft.create({
    data: {
      conversationId: c.id,
      triggerMessageId: c.messages[0].id,
      status: "SENT",
      content: c.messages[1].bodyText,
      reasoning: "intent=product_question confidence=0.9 sentiment=neutral escalate=false",
      isEscalated: false,
      escalationReasons: [],
      classification: {
        intent: "product_question",
        confidence: 0.9,
        language: "el",
        sentiment: "neutral",
        summary: "Ερώτηση για εφαρμογή/μέγεθος φορέματος.",
      },
    },
  });
  await prisma.review.create({
    data: { draftId: sentDraft.id, reviewerEmail: "charitos@thefashionproject.gr", action: "APPROVE" },
  });
  await prisma.auditLog.createMany({
    data: [
      { conversationId: c.id, draftId: sentDraft.id, actor: "agent", action: "draft_created", detail: { intent: "product_question" } },
      { conversationId: c.id, draftId: sentDraft.id, actor: "charitos@thefashionproject.gr", action: "draft_approve", detail: {} },
      { conversationId: c.id, draftId: sentDraft.id, actor: "charitos@thefashionproject.gr", action: "reply_sent", detail: { to: ["eleni.k@example.com"] } },
    ],
  });

  const counts = {
    conversations: await prisma.conversation.count(),
    pendingDrafts: await prisma.draft.count({ where: { status: "PENDING" } }),
  };
  console.log("Seeded sample data:", counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
