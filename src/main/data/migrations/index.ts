export const migrations: string[] = [
  `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS agent_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    command TEXT,
    args_json TEXT,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS terminal_layouts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    layout_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS session_history (
    id TEXT PRIMARY KEY,
    session_type TEXT NOT NULL,
    reference_id TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE agent_profiles
  ADD COLUMN project_id TEXT;
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_agent_profiles_project_id
  ON agent_profiles(project_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS chat_history_messages (
    id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    space_id TEXT NOT NULL,
    project_id TEXT,
    message_id TEXT NOT NULL,
    sort_index INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_chat_history_scope_space_sort
  ON chat_history_messages(scope_key, space_id, sort_index);
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_chat_history_project_id
  ON chat_history_messages(project_id);
  `
]
