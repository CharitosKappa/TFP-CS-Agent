-- New conversation status for threads the customer closed (no reply needed).
ALTER TYPE "ConversationStatus" ADD VALUE 'RESOLVED' BEFORE 'CLOSED';
