-- Per-message flag: does this message carry a real (non-inline) image attachment?
-- Set once at ingest so the review queue can flag image conversations without
-- re-fetching attachments from Microsoft Graph on every render.
ALTER TABLE "Message" ADD COLUMN "hasImageAttachment" BOOLEAN NOT NULL DEFAULT false;
