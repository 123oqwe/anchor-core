/**
 * L0 Runtime — SQLite WAL storage with full schema for all 8 product features.
 *
 * Schema covers: graph (bi-temporal) + memories (FTS5) + projects/tasks +
 * approval queue + agent executions + custom agents + cron + MCP servers +
 * scanner events (hash-chained for sync).
 *
 * Cross-platform: pure SQLite, no OS-specific code.
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.ANCHOR_DB_PATH ?? path.resolve(__dirname, "anchor.db");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export const DEFAULT_USER_ID = "default";

db.exec(`
  -- ── User + settings ──────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT 'User',
    email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT PRIMARY KEY,
    model_reasoning TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    model_fast TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
    local_processing INTEGER NOT NULL DEFAULT 0
  );

  -- ── Personal Knowledge Graph (bi-temporal) ───────────────────────
  CREATE TABLE IF NOT EXISTS graph_nodes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    valid_from TEXT NOT NULL DEFAULT (datetime('now')),
    valid_to TEXT,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_nodes_user_type ON graph_nodes(user_id, type);
  CREATE INDEX IF NOT EXISTS idx_nodes_user_status ON graph_nodes(user_id, status);

  CREATE TABLE IF NOT EXISTS graph_edges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    type TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    valid_from TEXT NOT NULL DEFAULT (datetime('now')),
    valid_to TEXT,
    FOREIGN KEY (from_node_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (to_node_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
  );

  -- ── Memory (episodic / semantic / working) + FTS5 ────────────────
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL DEFAULT 0.8,
    valid_from TEXT NOT NULL DEFAULT (datetime('now')),
    valid_to TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    title, content, tags,
    content='memories', content_rowid='rowid'
  );
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
  END;

  -- ── Twin insights ────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS twin_insights (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    insight TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.7,
    contraindication TEXT,
    source TEXT NOT NULL DEFAULT 'edits',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Projects + tasks (Workspace) ─────────────────────────────────
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    goal TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    state_json TEXT NOT NULL DEFAULT '{}',
    next_check_in TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    project_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Custom agents (user-defined) ─────────────────────────────────
  CREATE TABLE IF NOT EXISTS user_agents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL,
    tools_json TEXT NOT NULL DEFAULT '[]',
    trigger_type TEXT NOT NULL DEFAULT 'manual',
    trigger_config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Sessions + steps (plan FSM) ──────────────────────────────────
  CREATE TABLE IF NOT EXISTS action_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    plan_summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    compile_error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS action_steps (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    tool TEXT,
    runtime TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    error TEXT,
    started_at TEXT,
    finished_at TEXT,
    FOREIGN KEY (session_id) REFERENCES action_sessions(id) ON DELETE CASCADE
  );

  -- ── Approval queue (unified inbox) ───────────────────────────────
  CREATE TABLE IF NOT EXISTS approval_queue (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    source_ref_id TEXT NOT NULL,
    action_class TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_at TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── MCP servers (user-installed integrations) ────────────────────
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    transport TEXT NOT NULL DEFAULT 'stdio',
    command TEXT,
    args_json TEXT NOT NULL DEFAULT '[]',
    env_json TEXT NOT NULL DEFAULT '{}',
    url TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'disconnected',
    last_error TEXT,
    last_connected_at TEXT,
    tools_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Cron jobs (user-defined + system) ────────────────────────────
  CREATE TABLE IF NOT EXISTS user_crons (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    pattern TEXT NOT NULL,
    action TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Agent executions (audit log + GEPA fuel) ─────────────────────
  CREATE TABLE IF NOT EXISTS agent_executions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'success',
    latency_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Skills (auto-crystallized from repeated patterns) ────────────
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    steps_json TEXT NOT NULL DEFAULT '[]',
    trigger_pattern TEXT NOT NULL DEFAULT '',
    use_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Scanner events (hash-chained for cross-device sync) ──────────
  CREATE TABLE IF NOT EXISTS scanner_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    prev_hash TEXT NOT NULL DEFAULT '',
    this_hash TEXT NOT NULL
  );

  -- ── Agent KV state (per custom agent) ────────────────────────────
  CREATE TABLE IF NOT EXISTS agent_state (
    agent_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (agent_id, key)
  );

  -- ── Personal evolution state ─────────────────────────────────────
  CREATE TABLE IF NOT EXISTS evolution_state (
    user_id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- ── Portraits (Oracle Council output, versioned) ─────────────────
  CREATE TABLE IF NOT EXISTS portraits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_portraits_user ON portraits(user_id, version DESC);

  -- ── LLM call traces (GEPA fuel) ──────────────────────────────────
  CREATE TABLE IF NOT EXISTS llm_calls (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    task TEXT NOT NULL,
    model_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'success',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_llm_calls_task ON llm_calls(task, created_at DESC);
`);

export function logLLMCall(input: {
  task: string; modelId: string; inputTokens: number; outputTokens: number; latencyMs: number; status?: "success" | "failed"; error?: string;
}): void {
  db.prepare(
    "INSERT INTO llm_calls (id, user_id, task, model_id, input_tokens, output_tokens, latency_ms, status, error) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(
    Math.random().toString(36).slice(2, 14),
    DEFAULT_USER_ID,
    input.task, input.modelId, input.inputTokens, input.outputTokens, input.latencyMs,
    input.status ?? "success", input.error ?? null,
  );
}

// Seed default user
db.prepare("INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)").run(DEFAULT_USER_ID, "User");
db.prepare("INSERT OR IGNORE INTO settings (user_id) VALUES (?)").run(DEFAULT_USER_ID);

export function logExecution(agent: string, action: string, status: "success" | "failed" | "skipped" = "success", latencyMs?: number): void {
  db.prepare(
    "INSERT INTO agent_executions (id, user_id, agent, action, status, latency_ms) VALUES (?,?,?,?,?,?)"
  ).run(nanoid(), DEFAULT_USER_ID, agent, action.slice(0, 500), status, latencyMs ?? null);
}
