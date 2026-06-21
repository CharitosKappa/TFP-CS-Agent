-- Denormalised order number per conversation, for linking threads about the
-- same order (incl. ones the customer opens as a new thread).
ALTER TABLE "Conversation" ADD COLUMN "orderNumber" TEXT;
CREATE INDEX "Conversation_orderNumber_idx" ON "Conversation"("orderNumber");
