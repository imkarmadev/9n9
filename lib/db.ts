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
  `);

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
