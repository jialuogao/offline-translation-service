import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { openDb, type Db } from '../../apps/server/src/db/index.js';
import {
  CollectionService,
  DEFAULT_COLLECTION_NAME,
} from '../../apps/server/src/services/collectionService.js';
import { scratchDir } from '../helpers/paths.js';

/** CollectionService 单元测试（DESIGN.md §4 / §5.1 / §5.2）。 */

let db: Db;
let service: CollectionService;

beforeEach(() => {
  const dbPath = path.join(scratchDir('unit'), `collections-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
  service = new CollectionService(db);
});

afterEach(() => {
  if (db.open) db.close();
});

function insert(collectionId: string, source = '你好', target = 'EN[你好]'): string {
  return service.insertEntry({
    collectionId,
    sourceLang: 'zh',
    targetLang: 'en',
    sourceText: source,
    targetText: target,
    modelId: 'test-model',
  }).id;
}

describe('CollectionService', () => {
  it('§4.2 首次启动自动创建默认合集并设为 active', () => {
    const created = service.init();
    expect(created.name).toBe(DEFAULT_COLLECTION_NAME);
    expect(service.list()).toHaveLength(1);
    expect(service.getActive().id).toBe(created.id);
  });

  it('新建合集会成为 active，名称留空则用"未命名合集"', () => {
    service.init();
    const named = service.create('技术文档');
    expect(service.getActive().id).toBe(named.id);
    expect(named.name).toBe('技术文档');

    const unnamed = service.create();
    expect(unnamed.name).toBe('未命名合集');
    expect(service.getActive().id).toBe(unnamed.id);
  });

  it('列表按 updated_at 倒序，并带 entry_count', () => {
    const first = service.init();
    const second = service.create('第二个');
    insert(second.id);
    insert(second.id);

    const list = service.list();
    expect(list[0]?.id).toBe(second.id);
    expect(list[0]?.entry_count).toBe(2);
    const firstRow = list.find((item) => item.id === first.id);
    expect(firstRow?.entry_count).toBe(0);
  });

  it('切换 active 会更新该合集的 updated_at 并置顶', () => {
    const first = service.init();
    const second = service.create('第二个');
    expect(service.list()[0]?.id).toBe(second.id);

    const activated = service.setActive(first.id);
    expect(activated.id).toBe(first.id);
    expect(service.getActive().id).toBe(first.id);
    expect(service.list()[0]?.id).toBe(first.id);
    expect(activated.updated_at >= first.updated_at).toBe(true);
  });

  it('getActive 在 active 记录丢失时回退到最近更新的合集', () => {
    const first = service.init();
    db.prepare(`UPDATE meta SET value = '不存在的 id' WHERE key = 'active_collection_id'`).run();
    expect(service.getActive().id).toBe(first.id);
  });

  it('重命名拒绝空名称', () => {
    const collection = service.init();
    expect(() => service.rename(collection.id, '   ')).toThrowError(/不能为空/);
    expect(service.rename(collection.id, '新名字').name).toBe('新名字');
  });

  it('§4.1 删除合集级联删除其条目', () => {
    const collection = service.init();
    insert(collection.id);
    insert(collection.id);
    const remaining = service.create('保留');
    service.setActive(remaining.id);

    service.delete(collection.id);

    expect(service.get(collection.id)).toBeNull();
    const count = db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM entries`)
      .get();
    expect(count?.n).toBe(0);
  });

  it('§5.1 删除 active 合集后返回剩余合集，删空后自动新建默认合集', () => {
    const only = service.init();
    insert(only.id);
    const fallback = service.delete(only.id);
    expect(fallback.name).toBe(DEFAULT_COLLECTION_NAME);
    expect(fallback.id).not.toBe(only.id);
    expect(service.list()).toHaveLength(1);

    const second = service.create('第二个');
    service.setActive(second.id);
    const afterDelete = service.delete(second.id);
    expect(afterDelete.id).toBe(fallback.id);
    expect(service.getActive().id).toBe(fallback.id);
  });

  it('回归：反复"删空 → 自动新建 → 再删空"不会因嵌套事务失败', () => {
    // 曾经的缺陷：delete() 在删除事务内部调用 create()，嵌套 BEGIN 直接抛错，
    // 接口返回 500。这里连续 5 轮确保删除与创建是两步而非嵌套。
    let current = service.init();
    for (let round = 0; round < 5; round += 1) {
      insert(current.id);
      expect(() => service.delete(current.id)).not.toThrow();
      current = service.getActive();
      expect(current.name).toBe(DEFAULT_COLLECTION_NAME);
      expect(service.list()).toHaveLength(1);
    }
    expect(
      db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM entries`).get()?.n,
    ).toBe(0);
  });

  it('回归：批量删除与并发使用的嵌套事务可共存（SAVEPOINT）', () => {
    const collection = service.init();
    const ids = [insert(collection.id), insert(collection.id)];
    const outer = db.transaction(() => service.batchDeleteEntries(ids));
    expect(outer()).toBe(2);
    expect(service.listEntries(collection.id).total).toBe(0);
  });

  it('§5.2 条目分页按 created_at 倒序返回', () => {
    const collection = service.init();
    for (let index = 0; index < 7; index += 1) {
      insert(collection.id, `原文-${index}`, `EN[原文-${index}]`);
      // 保证 created_at 不同（时间戳精度为毫秒）。
      db.prepare(`UPDATE entries SET created_at = ? WHERE source_text = ?`).run(
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        `原文-${index}`,
      );
    }
    const page1 = service.listEntries(collection.id, 1, 3);
    expect(page1.total).toBe(7);
    expect(page1.page).toBe(1);
    expect(page1.items).toHaveLength(3);
    expect(page1.items[0]?.source_text).toBe('原文-6');

    const page3 = service.listEntries(collection.id, 3, 3);
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0]?.source_text).toBe('原文-0');
  });

  it('§5.2 批量删除返回实际删除数并忽略不存在的 id', () => {
    const collection = service.init();
    const first = insert(collection.id);
    const second = insert(collection.id);
    insert(collection.id);

    const deleted = service.batchDeleteEntries([first, second, '不存在', first]);
    expect(deleted).toBe(2);

    const cleared = service.clearEntries(collection.id);
    expect(cleared).toBe(1);
    expect(service.listEntries(collection.id).total).toBe(0);
  });

  it('单条删除不存在时返回 false', () => {
    expect(service.deleteEntry('不存在')).toBe(false);
    const collection = service.init();
    const id = insert(collection.id);
    expect(service.deleteEntry(id)).toBe(true);
  });

  it('访问不存在的合集抛出 COLLECTION_NOT_FOUND', () => {
    service.init();
    expect(() => service.listEntries('不存在')).toThrowError(/合集不存在/);
    expect(() => service.insertEntry({
      collectionId: '不存在',
      sourceLang: 'zh',
      targetLang: 'en',
      sourceText: 'x',
      targetText: 'y',
      modelId: null,
    })).toThrowError(/合集不存在/);
  });
});
