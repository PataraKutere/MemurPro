-- MemurPro listing metadata and API rate limiting
ALTER TABLE announcements ADD COLUMN departments_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE announcements ADD COLUMN employment_type TEXT;
ALTER TABLE announcements ADD COLUMN institution_type TEXT;
ALTER TABLE announcements ADD COLUMN announcement_type TEXT;

CREATE TABLE IF NOT EXISTS api_rate_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_rate_limits_window ON api_rate_limits(window_started_at);
