-- Listing metadata columns are included in schema.sql and have been applied to the active D1 database.
-- API rate limiting bucket table.
CREATE TABLE IF NOT EXISTS api_rate_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_rate_limits_window ON api_rate_limits(window_started_at);
