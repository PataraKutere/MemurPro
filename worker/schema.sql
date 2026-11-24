PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  homepage_url TEXT NOT NULL,
  feed_url TEXT,
  feed_type TEXT NOT NULL DEFAULT 'manual' CHECK (feed_type IN ('manual', 'rss', 'json')),
  adapter TEXT NOT NULL DEFAULT 'feed',
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'failed')),
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  institution TEXT,
  summary TEXT,
  category TEXT,
  city TEXT,
  education TEXT,
  score_type TEXT,
  minimum_score REAL,
  published_at TEXT,
  start_date TEXT,
  end_date TEXT,
  detail_url TEXT NOT NULL,
  source_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'check_required' CHECK (status IN ('open', 'closed', 'check_required')),
  content_hash TEXT,
  last_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_announcements_status_end_date
  ON announcements(status, end_date);
CREATE INDEX IF NOT EXISTS idx_announcements_city_education
  ON announcements(city, education);
CREATE INDEX IF NOT EXISTS idx_announcements_published_at
  ON announcements(published_at DESC);

-- Official source homepages are registered immediately.
-- Feed URLs intentionally remain empty until each source's public feed/API is verified.
INSERT OR IGNORE INTO sources (id, name, homepage_url, feed_type, status) VALUES
  ('kariyer-kapisi', 'Kariyer Kapısı', 'https://kariyerkapisi.gov.tr/', 'manual', 'pending'),
  ('osym', 'ÖSYM', 'https://www.osym.gov.tr/SinavGrubu/Index/3', 'manual', 'pending'),
  ('iskur', 'İŞKUR', 'https://www.iskur.gov.tr/', 'manual', 'pending'),
  ('ilan-gov', 'İlan.gov.tr', 'https://www.ilan.gov.tr/', 'manual', 'pending'),
  ('resmi-gazete', 'Resmî Gazete', 'https://www.resmigazete.gov.tr/', 'manual', 'pending'),
  ('kamuilan-sbb', 'Kamu İlanları (SBB)', 'https://kamuilan.sbb.gov.tr/', 'manual', 'pending');
