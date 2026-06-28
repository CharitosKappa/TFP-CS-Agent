-- AlterEnum
ALTER TYPE "ConversationStatus" ADD VALUE 'AWAITING_FOLLOWUP';

-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "promisesFollowUp" BOOLEAN NOT NULL DEFAULT false;
