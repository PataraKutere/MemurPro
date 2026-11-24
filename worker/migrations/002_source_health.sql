-- MemurPro source health history and 24-hour metrics
CREATE TABLE IF NOT EXISTS source_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success','failed')),
  item_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_source_checks_source_checked
  ON source_checks(source_id, checked_at DESC);
