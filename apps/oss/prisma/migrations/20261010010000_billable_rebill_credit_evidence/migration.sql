-- New decisions retain every reviewed note. For existing decisions, only the primary note is
-- known; do not invent a complete reviewed set from credits that may have been issued later.
ALTER TABLE "deliverable_rebill" ADD COLUMN "creditNoteIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
