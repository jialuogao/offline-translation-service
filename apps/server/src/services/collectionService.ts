import { randomUUID } from 'node:crypto';
import type { Collection, Entry, Lang } from '@ots/contracts';
import { ErrorCode, badRequest, notFound } from '../errors.js';
import { getMeta, nowIso, setMeta, type Db } from '../db/index.js';

/**
 * 合集与历史条目的唯一数据入口（DESIGN.md §3.2 / §5.1 / §5.2）。
 *
 * 路由层只能通过本服务读写数据库；SQL 全部集中在这里。
 */

export const DEFAULT_COLLECTION_NAME = '默认合集';
export const UNNAMED_COLLECTION_NAME = '未命名合集';
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

const ACTIVE_KEY = 'active_collection_id';

interface CollectionRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  entry_count: number;
}

interface EntryRow {
  id: string;
  collection_id: string;
  source_lang: string;
  target_lang: string;
  source_text: string;
  target_text: string;
  model_id: string | null;
  created_at: string;
}

function toCollection(row: CollectionRow): Collection {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    entry_count: Number(row.entry_count),
  };
}

function toEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    collection_id: row.collection_id,
    source_lang: row.source_lang as Lang,
    target_lang: row.target_lang as Lang,
    source_text: row.source_text,
    target_text: row.target_text,
    model_id: row.model_id,
    created_at: row.created_at,
  };
}

export interface NewEntry {
  collectionId: string;
  sourceLang: Lang;
  targetLang: Lang;
  sourceText: string;
  targetText: string;
  modelId: string | null;
}

export class CollectionService {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- 初始化

  /**
   * 首次启动若 `collections` 为空则创建"默认合集"并设为 active（DESIGN.md §4.2），
   * 并确保 `meta.active_collection_id` 指向一个存在的合集。
   */
  init(): Collection {
    const count = this.db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM collections`)
      .get();
    if ((count?.n ?? 0) === 0) {
      return this.create(DEFAULT_COLLECTION_NAME);
    }

    const activeId = getMeta(this.db, ACTIVE_KEY);
    if (activeId !== null) {
      const exists = this.db
        .prepare<[string], { id: string }>(`SELECT id FROM collections WHERE id = ?`)
        .get(activeId);
      if (exists !== undefined) return this.getOrThrow(activeId);
    }

    // 记录丢失或指向已删除合集：回退到最近更新的一个。
    const fallback = this.db
      .prepare<[], { id: string }>(
        `SELECT id FROM collections ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      )
      .get();
    if (fallback === undefined) return this.create(DEFAULT_COLLECTION_NAME);
    return this.setActive(fallback.id);
  }

  // ---------------------------------------------------------------- 合集

  list(): Collection[] {
    const rows = this.db
      .prepare<[], CollectionRow>(
        `SELECT c.id, c.name, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM entries e WHERE e.collection_id = c.id) AS entry_count
           FROM collections c
          ORDER BY c.updated_at DESC, c.created_at DESC`,
      )
      .all();
    return rows.map(toCollection);
  }

  get(id: string): Collection | null {
    const row = this.db
      .prepare<[string], CollectionRow>(
        `SELECT c.id, c.name, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM entries e WHERE e.collection_id = c.id) AS entry_count
           FROM collections c WHERE c.id = ?`,
      )
      .get(id);
    return row === undefined ? null : toCollection(row);
  }

  getOrThrow(id: string): Collection {
    const found = this.get(id);
    if (found === null) {
      throw notFound(ErrorCode.collectionNotFound, '合集不存在');
    }
    return found;
  }

  create(name?: string, options: { activate?: boolean } = {}): Collection {
    const trimmed = (name ?? '').trim();
    const finalName = trimmed === '' ? UNNAMED_COLLECTION_NAME : trimmed;
    if (finalName.length > 200) {
      throw badRequest(ErrorCode.invalidRequest, '合集名称过长（上限 200 字符）');
    }
    const id = randomUUID();
    // 计算机的毫秒时钟可能两次调用返回同一毫秒；列表按 updated_at 倒序，因此这里
    // 强制新合集的 updated_at 严格大于现有最大值，保证"新建/切换后置顶"稳定。
    const now = this.nextTimestamp();
    this.db
      .prepare(
        `INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run(id, finalName, now, now);
    if (options.activate !== false) {
      setMeta(this.db, ACTIVE_KEY, id);
    }
    return this.getOrThrow(id);
  }

  getActive(): Collection {
    return this.init();
  }

  /** 切换当前合集（DESIGN.md §5.1 PUT /api/collections/active）。 */
  setActive(id: string): Collection {
    this.getOrThrow(id);
    const previous = getMeta(this.db, ACTIVE_KEY);
    setMeta(this.db, ACTIVE_KEY, id);
    if (previous !== id) {
      // §4.1：每次"切换为当前"更新 updated_at。
      this.touch(id);
    }
    return this.getOrThrow(id);
  }

  rename(id: string, name: string): Collection {
    this.getOrThrow(id);
    const trimmed = name.trim();
    if (trimmed === '') {
      throw badRequest(ErrorCode.invalidRequest, '合集名称不能为空');
    }
    if (trimmed.length > 200) {
      throw badRequest(ErrorCode.invalidRequest, '合集名称过长（上限 200 字符）');
    }
    this.db
      .prepare(`UPDATE collections SET name = ?, updated_at = ? WHERE id = ?`)
      .run(trimmed, nowIso(), id);
    return this.getOrThrow(id);
  }

  /**
   * 删除合集并级联其条目（DESIGN.md §5.1）。
   * 返回删除后的新 active 合集：优先最近更新的剩余合集，没有则新建默认合集。
   *
   * 注意：删除与"新建默认合集"必须分两步。`create()` 自身会开启事务，如果在删除
   * 事务内部调用，就会嵌套事务并抛错（曾导致请求 500）。因此这里先取好候选、
   * 提交删除，必要时再单独创建。
   */
  delete(id: string): Collection {
    this.getOrThrow(id);
    const wasActive = getMeta(this.db, ACTIVE_KEY) === id;

    const next = wasActive
      ? this.db
          .prepare<[string], { id: string }>(
            `SELECT id FROM collections WHERE id <> ?
              ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
          )
          .get(id)
      : undefined;

    this.db.prepare(`DELETE FROM collections WHERE id = ?`).run(id);

    if (!wasActive) return this.getActive();
    if (next === undefined) return this.create(DEFAULT_COLLECTION_NAME);
    setMeta(this.db, ACTIVE_KEY, next.id);
    return this.getOrThrow(next.id);
  }

  // ---------------------------------------------------------------- 条目

  listEntries(
    collectionId: string,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  ): { items: Entry[]; total: number; page: number; pageSize: number } {
    this.getOrThrow(collectionId);
    const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
    const safeSize =
      Number.isFinite(pageSize) && pageSize >= 1
        ? Math.min(Math.floor(pageSize), MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;

    const total = Number(
      this.db
        .prepare<[string], { n: number }>(
          `SELECT COUNT(*) AS n FROM entries WHERE collection_id = ?`,
        )
        .get(collectionId)?.n ?? 0,
    );
    const rows = this.db
      .prepare<[string, number, number], EntryRow>(
        `SELECT id, collection_id, source_lang, target_lang, source_text, target_text, model_id, created_at
           FROM entries
          WHERE collection_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ? OFFSET ?`,
      )
      .all(collectionId, safeSize, (safePage - 1) * safeSize);

    return { items: rows.map(toEntry), total, page: safePage, pageSize: safeSize };
  }

  /** 落库一条翻译结果，并更新所属合集 `updated_at`（DESIGN.md §5.3 步骤 5）。 */
  insertEntry(entry: NewEntry): Entry {
    this.getOrThrow(entry.collectionId);
    const id = randomUUID();
    const now = nowIso();
    const run = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO entries
             (id, collection_id, source_lang, target_lang, source_text, target_text, model_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          entry.collectionId,
          entry.sourceLang,
          entry.targetLang,
          entry.sourceText,
          entry.targetText,
          entry.modelId,
          now,
        );
      this.touch(entry.collectionId, now);
    });
    run();
    return this.getEntryOrThrow(id);
  }

  getEntry(id: string): Entry | null {
    const row = this.db
      .prepare<[string], EntryRow>(
        `SELECT id, collection_id, source_lang, target_lang, source_text, target_text, model_id, created_at
           FROM entries WHERE id = ?`,
      )
      .get(id);
    return row === undefined ? null : toEntry(row);
  }

  private getEntryOrThrow(id: string): Entry {
    const found = this.getEntry(id);
    if (found === null) throw notFound(ErrorCode.entryNotFound, '条目不存在');
    return found;
  }

  /** 删除单条；不存在时返回 false（路由据此决定 204 或 404）。 */
  deleteEntry(id: string): boolean {
    const entry = this.getEntry(id);
    if (entry === null) return false;
    const run = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM entries WHERE id = ?`).run(id);
      this.touch(entry.collection_id);
    });
    run();
    return true;
  }

  /** 批量删除（DESIGN.md §5.2）；返回实际删除条数，并按受影响合集更新 `updated_at`。 */
  batchDeleteEntries(ids: string[]): number {
    return this.deleteMany(ids);
  }

  /** 清空合集但保留合集本身；返回删除条数。 */
  clearEntries(collectionId: string): number {
    this.getOrThrow(collectionId);
    const ids = this.db
      .prepare<[string], { id: string }>(
        `SELECT id FROM entries WHERE collection_id = ?`,
      )
      .all(collectionId)
      .map((row) => row.id);
    return this.deleteMany(ids);
  }

  private deleteMany(ids: string[]): number {
    const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
    if (unique.length === 0) return 0;

    const affected = new Set<string>();
    const statement = this.db.prepare<[string]>(`DELETE FROM entries WHERE id = ?`);
    const run = this.db.transaction(() => {
      let deleted = 0;
      for (const id of unique) {
        const entry = this.getEntry(id);
        if (entry === null) continue;
        affected.add(entry.collection_id);
        deleted += statement.run(id).changes;
      }
      for (const collectionId of affected) this.touch(collectionId);
      return deleted;
    });
    return run();
  }

  // ---------------------------------------------------------------- 内部

  /** 更新合集 `updated_at`；`at` 用于与新条目共用同一时间戳。 */
  private touch(collectionId: string, at?: string): void {
    this.db
      .prepare(`UPDATE collections SET updated_at = ? WHERE id = ?`)
      .run(at ?? this.nextTimestamp(), collectionId);
  }

  /**
   * 返回严格大于现有最大 `updated_at` 的 ISO 时间戳。
   *
   * 列表与 active 回退都依赖 `updated_at` 排序，而相邻两次写入可能落在同一毫秒，
   * 导致"最后操作的对象"排序不稳定；这里在冲突时 +1ms。
   */
  private nextTimestamp(): string {
    const row = this.db
      .prepare<[], { max: string | null }>(`SELECT MAX(updated_at) AS max FROM collections`)
      .get();
    const now = Date.now();
    const previous = row?.max === null || row?.max === undefined ? 0 : Date.parse(row.max);
    return new Date(Number.isFinite(previous) && previous >= now ? previous + 1 : now).toISOString();
  }
}
