// GDPR data lifecycle: retention purge, erasure (Art.17), and export (Art.15/20).
// Deletes cascade to messages, drafts, reviews and audit logs via the schema's
// onDelete: Cascade relations.
import { prisma } from "@/lib/db";
import { log } from "@/lib/observability/logger";

const DAY_MS = 86_400_000;

/** Retention window in days; configurable via RETENTION_DAYS (set per DPO policy). */
export function retentionDays(): number {
  const n = Number(process.env.RETENTION_DAYS ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 730; // default: 2 years
}

export interface PurgeResult {
  cutoff: string;
  conversations: number;
  dryRun: boolean;
}

/**
 * Deletes conversations not touched within the retention window (and everything
 * they own). Pass `dryRun` to count without deleting.
 */
export async function purgeExpiredData(
  opts: { days?: number; dryRun?: boolean } = {},
): Promise<PurgeResult> {
  const days = opts.days ?? retentionDays();
  const cutoff = new Date(Date.now() - days * DAY_MS);
  const where = { updatedAt: { lt: cutoff } };

  const conversations = await prisma.conversation.count({ where });
  if (!opts.dryRun && conversations > 0) {
    await prisma.conversation.deleteMany({ where });
    log.info("retention_purge", { days, cutoff: cutoff.toISOString(), conversations });
  }
  return { cutoff: cutoff.toISOString(), conversations, dryRun: !!opts.dryRun };
}

/** Erases all data for a customer email (Art.17 right to erasure). */
export async function eraseCustomer(
  email: string,
): Promise<{ email: string; conversations: number }> {
  const e = email.trim().toLowerCase();
  if (!e) throw new Error("email required");
  const where = { customerEmail: e };
  const conversations = await prisma.conversation.count({ where });
  await prisma.conversation.deleteMany({ where });
  log.info("customer_erased", { conversations });
  return { email: e, conversations };
}

/** Exports all stored data for a customer email (Art.15/20 access/portability). */
export async function exportCustomer(email: string) {
  const e = email.trim().toLowerCase();
  if (!e) throw new Error("email required");
  const conversations = await prisma.conversation.findMany({
    where: { customerEmail: e },
    include: { messages: true, drafts: { include: { review: true } } },
  });
  const conversationIds = conversations.map((c) => c.id);
  const auditLogs = conversationIds.length
    ? await prisma.auditLog.findMany({ where: { conversationId: { in: conversationIds } } })
    : [];
  return { email: e, exportedAt: new Date().toISOString(), conversations, auditLogs };
}
