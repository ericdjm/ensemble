/** Ordered schema migrations. Never edit an applied migration; append a new one. */
export const MIGRATIONS: ReadonlyArray<{ id: number; sql: string }> = [
  {
    id: 1,
    sql: `
CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  default_base TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE script_approvals (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('setup','run','archive')),
  script_hash TEXT NOT NULL,
  script_text TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, kind)
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  port INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('pending_approval','creating','copying','setting_up','ready','setup_failed','archived')),
  creation_json TEXT NOT NULL DEFAULT '{}',
  copy_manifest_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_state TEXT,
  pr_json TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (repo_id, name)
);
CREATE UNIQUE INDEX workspaces_active_port ON workspaces(port) WHERE status != 'archived';
CREATE UNIQUE INDEX workspaces_active_path ON workspaces(path) WHERE status != 'archived';

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent TEXT NOT NULL CHECK (agent IN ('claude','codex')),
  tmux_name TEXT NOT NULL,
  cli_session_id TEXT,
  transcript_path TEXT,
  remote_control INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN
    ('starting','working','needs_input','idle','exited','error')),
  exit_code INTEGER,
  process_state TEXT NOT NULL DEFAULT 'unknown' CHECK (process_state IN
    ('running','dead','missing','unknown')),
  freshness TEXT NOT NULL DEFAULT 'unknown' CHECK (freshness IN ('current','stale','unknown')),
  auth_mode TEXT NOT NULL DEFAULT 'unchecked' CHECK (auth_mode IN
    ('subscription','api','other','unknown','unchecked')),
  auth_label TEXT,
  auth_checked_at TEXT,
  billing_opt_in INTEGER NOT NULL DEFAULT 0,
  billing_ack INTEGER NOT NULL DEFAULT 0,
  refusal_reason TEXT,
  predecessor_id TEXT REFERENCES sessions(id),
  successor_id TEXT REFERENCES sessions(id),
  hook_generation INTEGER NOT NULL DEFAULT 1,
  last_seq INTEGER NOT NULL DEFAULT 0,
  pending_inputs_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  generation INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  tool_name TEXT,
  source_ts TEXT,
  ingested_at TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  UNIQUE (session_id, generation, seq)
);

CREATE TABLE event_gaps (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  generation INTEGER NOT NULL,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL,
  count INTEGER NOT NULL,
  reason TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (session_id, generation, reason)
);

CREATE TABLE archives (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  recovery_dir TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    sql: `
ALTER TABLE sessions ADD COLUMN hook_token_hash TEXT;
ALTER TABLE sessions ADD COLUMN cli_options_json TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    id: 3,
    sql: `
ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'worktree';
`,
  },
  {
    id: 4,
    sql: `
ALTER TABLE sessions ADD COLUMN last_answer TEXT;
ALTER TABLE sessions ADD COLUMN last_answer_at TEXT;
ALTER TABLE sessions ADD COLUMN last_answer_source TEXT;
CREATE TABLE relays (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  a_session_id TEXT NOT NULL REFERENCES sessions(id),
  b_session_id TEXT NOT NULL REFERENCES sessions(id),
  awaiting_session_id TEXT,
  max_rounds INTEGER NOT NULL,
  rounds_done INTEGER NOT NULL DEFAULT 0,
  done_marker TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','done','limit','stopped','error','interrupted')),
  error TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
`,
  },
  {
    id: 5,
    sql: `
ALTER TABLE sessions ADD COLUMN label TEXT;
ALTER TABLE sessions ADD COLUMN notes TEXT;
ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN adopted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN claude_agent_id TEXT;
`,
  },
];
