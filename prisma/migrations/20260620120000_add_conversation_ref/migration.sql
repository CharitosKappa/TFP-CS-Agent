-- Add a human-friendly auto-incrementing reference to Conversation.
-- SERIAL backfills existing rows and sets up the sequence + default (matches
-- Prisma's `Int @unique @default(autoincrement())`).
ALTER TABLE "Conversation" ADD COLUMN "ref" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_ref_key" ON "Conversation"("ref");
