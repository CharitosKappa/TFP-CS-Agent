-- Stable cross-folder Message-ID for deduping Sent Items ingestion against the
-- copy recorded when a reply is sent in-app (folder-specific Graph ids differ).
ALTER TABLE "Message" ADD COLUMN "internetMessageId" TEXT;
CREATE UNIQUE INDEX "Message_internetMessageId_key" ON "Message"("internetMessageId");
