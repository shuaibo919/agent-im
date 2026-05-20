CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  role TEXT DEFAULT 'agent',
  description TEXT,
  persona TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  description TEXT,
  participants TEXT NOT NULL,
  workspace TEXT,
  status TEXT DEFAULT 'open',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to TEXT,
  read_by TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (thread_id) REFERENCES threads(id),
  FOREIGN KEY (sender) REFERENCES profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS agent_endpoints (
  id TEXT PRIMARY KEY,
  mcp_url TEXT NOT NULL,
  display_name TEXT,
  status TEXT DEFAULT 'active',
  capabilities TEXT DEFAULT '{}',
  tools TEXT DEFAULT '[]',
  last_connected_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS local_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  exe_path TEXT,
  config_dir TEXT,
  models TEXT DEFAULT '[]',
  detected_at TEXT DEFAULT (datetime('now'))
);
