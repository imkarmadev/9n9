import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

const databasePath =
  process.env.N9N_DATABASE_PATH ??
  path.join(process.cwd(), "data", "9n9.db");

type GlobalDatabase = typeof globalThis & {
  __n9nDatabase?: Database.Database;
};

const globalDatabase = globalThis as GlobalDatabase;

function createDatabase() {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const instance = new Database(databasePath);

  instance.pragma("journal_mode = WAL");
  instance.pragma("foreign_keys = ON");
  instance.pragma("busy_timeout = 5000");

  instance.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 0,
      graph TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      input TEXT,
      output TEXT,
      error TEXT,
      trace TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY(workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_runs_workflow_started
      ON runs(workflow_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      password_updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_hash TEXT NOT NULL,
      csrf_token TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      user_agent TEXT,
      ip TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expiry
      ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      encrypted_data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_credentials_name
      ON credentials(name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      event TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      ip TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_created
      ON audit_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS workflow_versions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
      UNIQUE(workflow_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_versions
      ON workflow_versions(workflow_id, version DESC);

    CREATE TABLE IF NOT EXISTS workflow_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      graph TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_templates_name
      ON workflow_templates(name COLLATE NOCASE);
  `);

  const workflowColumns = instance
    .prepare("PRAGMA table_info(workflows)")
    .all() as Array<{ name: string }>;
  if (!workflowColumns.some((column) => column.name === "webhook_token_hash")) {
    instance.exec("ALTER TABLE workflows ADD COLUMN webhook_token_hash TEXT");
  }
  if (!workflowColumns.some((column) => column.name === "description")) {
    instance.exec("ALTER TABLE workflows ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }
  if (!workflowColumns.some((column) => column.name === "tags")) {
    instance.exec("ALTER TABLE workflows ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
  }
  if (!workflowColumns.some((column) => column.name === "archived_at")) {
    instance.exec("ALTER TABLE workflows ADD COLUMN archived_at TEXT");
  }
  instance.exec("CREATE INDEX IF NOT EXISTS idx_workflows_archived_updated ON workflows(archived_at, updated_at DESC)");
  const sessionColumns = instance
    .prepare("PRAGMA table_info(sessions)")
    .all() as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "csrf_token")) {
    instance.exec("ALTER TABLE sessions ADD COLUMN csrf_token TEXT");
  }

  return instance;
}

function getDatabase() {
  if (!globalDatabase.__n9nDatabase) {
    globalDatabase.__n9nDatabase = createDatabase();
  }
  return globalDatabase.__n9nDatabase;
}

export const db = new Proxy({} as Database.Database, {
  get(_target, property) {
    const instance = getDatabase();
    const value = Reflect.get(instance, property);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
