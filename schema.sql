-- BASTARD Feedback API — D1 Schema

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  bastard_version TEXT NOT NULL,
  node_version TEXT,
  os TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Round metrics
  round_id INTEGER,
  gate_passed INTEGER, -- 0/1
  round_duration_minutes INTEGER,
  total_rounds_completed INTEGER,

  -- Quality metrics
  slop_score TEXT,
  design_score TEXT,
  design_checks_passed INTEGER,
  coherence_score INTEGER,

  -- JSON blobs for flexible data
  gate_checks TEXT,           -- JSON: { checkId: boolean }
  slop_patterns TEXT,         -- JSON: { patternName: count }
  coherence_issue_types TEXT, -- JSON: { issueType: count }
  parents_installed TEXT      -- JSON: ["bmad", "gsd"]
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_hash);

-- Materialized aggregate view (refreshed by cron or on read)
CREATE TABLE IF NOT EXISTS insights_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1), -- singleton row
  data TEXT NOT NULL,                      -- JSON blob
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
