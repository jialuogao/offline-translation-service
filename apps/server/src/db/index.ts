import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, type Database } from './sqlite.js';

/**
 * SQLite 连接、schema 与迁移（DESIGN.md §4）。
 *
 * - 同步 API，单例，由 bootstrap.ts 在启动时创建并注入服务层。
 * - 时间戳统一 ISO 8601 UTC 文本；`entries.collection_id` 外键 `ON DELETE CASCADE`。
 * - 当前合集 id 存 `meta['active_collection_id']`（不单独建表）。
 */

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS collections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  source_lang   TEXT NOT NULL,
  target_lang   TEXT NOT NULL,
  source_text   TEXT NOT NULL,
  target_text   TEXT NOT NULL,
  model_id      TEXT,
  created_at    TEXT NOT NULL,
  CHECK (source_lang IN ('zh','en')),
  CHECK (target_lang IN ('zh','en')),
  CHECK (source_lang <> target_lang)
);

CREATE INDEX IF NOT EXISTS idx_entries_collection_created
  ON entries (collection_id, created_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export type Db = Database;

/** 打开（必要时创建）数据库文件并确保 schema 就绪。 */
export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = openDatabase(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

/** 写入 schema 并记录版本；当前只有 v1，保留迁移位以便后续扩展。 */
export function migrate(db: Db): void {
  db.exec(SCHEMA_SQL);
  const current = db
    .prepare<[], { value: string | null }>(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get();
  if (current === undefined) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function getMeta(db: Db, key: string): string | null {
  const row = db
    .prepare<[string], { value: string | null }>(`SELECT value FROM meta WHERE key = ?`)
    .get(key);
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string | null): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
