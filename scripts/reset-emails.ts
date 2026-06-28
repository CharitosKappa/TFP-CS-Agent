import "dotenv/config";
import { prisma } from "../src/lib/db";

// Wipes ALL ingested email data — conversations, messages, drafts, reviews and
// audit logs — to reset to a clean slate before a fresh ingest. Deleting the
// conversations cascades to messages/drafts/reviews/conversation-tied audit
// logs (see schema); orphan audit logs (conversationId null) are cleared too.
async function main() {
  const before = {
    conversations: await prisma.conversation.count(),
    messages: await prisma.message.count(),
    drafts: await prisma.draft.count(),
    reviews: await prisma.review.count(),
    auditLogs: await prisma.auditLog.count(),
  };
  console.log("Before:", before);

  await prisma.auditLog.deleteMany({});
  await prisma.conversation.deleteMany({});

  const after = {
    conversations: await prisma.conversation.count(),
    messages: await prisma.message.count(),
    drafts: await prisma.draft.count(),
    reviews: await prisma.review.count(),
    auditLogs: await prisma.auditLog.count(),
  };
  console.log("After:", after);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
