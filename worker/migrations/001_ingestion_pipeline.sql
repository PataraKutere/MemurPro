-- MemurPro ingestion pipeline migration 001
ALTER TABLE sources ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN backoff_until TEXT;

ALTER TABLE announcements ADD COLUMN dedupe_hash TEXT;
ALTER TABLE announcements ADD COLUMN source_refs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE announcements ADD COLUMN publication_state TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE announcements ADD COLUMN position_count INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_announcements_dedupe_hash
  ON announcements(dedupe_hash)
  WHERE dedupe_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sources_backoff
  ON sources(backoff_until);
