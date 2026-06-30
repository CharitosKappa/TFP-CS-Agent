import { execKw } from "./client";

export interface OdooAttachment {
  name: string;
  mimetype: string;
  /** base64-encoded file bytes (Odoo ir.attachment.datas). */
  base64: string;
}

/**
 * Reads a single ir.attachment's binary by id (read-only). Returns null if the
 * attachment is missing or has no stored bytes. The binary is never persisted
 * locally — callers fetch it on demand (e.g. at send time) and hand it straight
 * to the outgoing email.
 */
export async function fetchOdooAttachment(id: number): Promise<OdooAttachment | null> {
  const rows = await execKw<{ name: string | false; mimetype: string | false; datas: string | false }[]>(
    "ir.attachment", "read", [[id]], { fields: ["name", "mimetype", "datas"] },
  );
  const r = rows[0];
  if (!r || !r.datas) return null;
  return {
    name: r.name || `attachment-${id}.pdf`,
    mimetype: r.mimetype || "application/octet-stream",
    base64: r.datas,
  };
}
