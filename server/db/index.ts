import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

export type Db = Database.Database;

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_version").all() as Array<{ id: number }>).map((r) => r.id),
  );
  const run = db.transaction((id: number, sql: string) => {
    db.exec(sql);
    db.prepare("INSERT INTO schema_version (id, applied_at) VALUES (?, ?)").run(
      id,
      new Date().toISOString(),
    );
  });
  for (const m of MIGRATIONS) {
    if (!applied.has(m.id)) run(m.id, m.sql);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
