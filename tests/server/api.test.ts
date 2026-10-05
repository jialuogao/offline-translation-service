import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from '../mock-lmstudio/server.js';
import { createTestContext, type TestContext } from '../helpers/context.js';
import { api } from '../helpers/http.js';
import type { Collection, Entry, EntryPage } from '@ots/contracts';

/** 合集与历史条目的 REST 契约测试（DESIGN.md §5.1 / §5.2）。 */

let mock: MockServer;
let ctx: TestContext;

beforeEach(async () => {
  mock = await startMockServer();
  ctx = await createTestContext({ lmStudioBaseUrl: mock.baseUrl });
});

afterEach(async () => {
  await ctx.close();
  await mock.close();
});

describe('GET /api/collections', () => {
  it('返回默认合集数组（§4.2 初始数据）', async () => {
    const response = await api<Collection[]>(ctx.baseUrl, 'GET', '/api/collections');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]?.entry_count).toBe(0);
  });

  it('回归：测试端口落在安全区间，避免 fetch 的 bad port 随机失败', () => {
    // Windows 的 listen(0) 可能给出 fetch 拒绝的端口（如 6543），表现为随机
    // "fetch failed / bad port"。见 tests/helpers/paths.ts#listenOnSafePort。
    expect(ctx.port).toBeGreaterThanOrEqual(49152);
    expect(ctx.port).toBeLessThanOrEqual(65535);
  });
});

describe('POST /api/collections', () => {
  it('创建合集返回 201 并成为 active', async () => {
    const created = await api<Collection>(ctx.baseUrl, 'POST', '/api/collections', {
      name: '技术文档',
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('技术文档');

    const active = await api<{ collection: Collection }>(
      ctx.baseUrl,
      'GET',
      '/api/collections/active',
    );
    expect(active.body.collection.id).toBe(created.body.id);
  });

  it('缺省 name 时使用"未命名合集"', async () => {
    const created = await api<Collection>(ctx.baseUrl, 'POST', '/api/collections', {});
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('未命名合集');
  });

  it('name 类型非法返回 400 INVALID_REQUEST', async () => {
    const bad = await api<{ error: string }>(ctx.baseUrl, 'POST', '/api/collections', {
      name: 42,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('INVALID_REQUEST');
  });
});

describe('PUT /api/collections/active', () => {
  it('切换 active 并返回该合集', async () => {
    const first = (
      await api<Collection[]>(ctx.baseUrl, 'GET', '/api/collections')
    ).body[0];
    const second = (
      await api<Collection>(ctx.baseUrl, 'POST', '/api/collections', { name: '第二个' })
    ).body;
    expect(first).toBeDefined();

    const switched = await api<{ collection: Collection }>(ctx.baseUrl, 'PUT', '/api/collections/active', {
      id: first?.id,
    });
    expect(switched.status).toBe(200);
    expect(switched.body.collection.id).toBe(first?.id);
    expect(switched.body.collection.id).not.toBe(second.id);
  });

  it('id 不存在返回 404 COLLECTION_NOT_FOUND', async () => {
    const response = await api<{ error: string }>(
      ctx.baseUrl,
      'PUT',
      '/api/collections/active',
      { id: '不存在' },
    );
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('COLLECTION_NOT_FOUND');
  });

  it('缺 id 返回 400 INVALID_REQUEST', async () => {
    const response = await api<{ error: string }>(ctx.baseUrl, 'PUT', '/api/collections/active', {});
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('INVALID_REQUEST');
  });
});

describe('PATCH /api/collections/:id', () => {
  it('重命名并返回合集', async () => {
    const created = (
      await api<Collection>(ctx.baseUrl, 'POST', '/api/collections', { name: '旧名字' })
    ).body;
    const renamed = await api<Collection>(
      ctx.baseUrl,
      'PATCH',
      `/api/collections/${created.id}`,
      { name: '新名字' },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('新名字');
  });

  it('空名字返回 400，不存在的合集返回 404', async () => {
    const created = (
      await api<Collection>(ctx.baseUrl, 'POST', '/api/collections', { name: 'A' })
    ).body;
    expect(
      (await api<{ error: string }>(ctx.baseUrl, 'PATCH', `/api/collections/${created.id}`, {
        name: '   ',
      })).status,
    ).toBe(400);
    expect(
      (await api<{ error: string }>(ctx.baseUrl, 'PATCH', '/api/collections/不存在', {
        name: 'X',
      })).status,
    ).toBe(404);
  });
});

describe('DELETE /api/collections/:id', () => {
  it('删除非 active 合集返回当前 active', async () => {
    const first = (
      await api<Collection[]>(ctx.baseUrl, 'GET', '/api/collections')
    ).body[0];
    const second = (
      await api<Collection>(ctx.baseUrl, 'POST', '/api/collections', { name: '第二个' })
    ).body;

    const deleted = await api<{ collection: Collection }>(
      ctx.baseUrl,
      'DELETE',
      `/api/collections/${first?.id}`,
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.collection.id).toBe(second.id);
  });

  it('删除 active 合集后自动切到剩余合集', async () => {
    const first = (
      await api<Collection[]>(ctx.baseUrl, 'GET', '/api/collections')
    ).body[0];
    const second = (
      await api<Collection>(ctx.baseUrl, 'POST', '/api/collections', { name: '第二个' })
    ).body;
    await api(ctx.baseUrl, 'PUT', '/api/collections/active', { id: second.id });

    const deleted = await api<{ collection: Collection }>(
      ctx.baseUrl,
      'DELETE',
      `/api/collections/${second.id}`,
    );
    expect(deleted.body.collection.id).toBe(first?.id);
  });

  it('删空所有合集后自动新建默认合集', async () => {
    const only = (await api<Collection[]>(ctx.baseUrl, 'GET', '/api/collections')).body[0];
    const deleted = await api<{ collection: Collection }>(
      ctx.baseUrl,
      'DELETE',
      `/api/collections/${only?.id}`,
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.collection.name).toBe('默认合集');
    expect(deleted.body.collection.id).not.toBe(only?.id);
  });

  it('不存在返回 404', async () => {
    expect(
      (await api<{ error: string }>(ctx.baseUrl, 'DELETE', '/api/collections/不存在')).status,
    ).toBe(404);
  });
});

describe('历史条目', () => {
  async function seed(count: number): Promise<{ collectionId: string; ids: string[] }> {
    const collection = (
      await api<Collection>(ctx.baseUrl, 'POST', '/api/collections', { name: `合集-${count}` })
    ).body;
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const inserted = ctx.collections.insertEntry({
        collectionId: collection.id,
        sourceLang: 'zh',
        targetLang: 'en',
        sourceText: `原文-${index}`,
        targetText: `EN[原文-${index}]`,
        modelId: 'mock',
      });
      ids.push(inserted.id);
    }
    return { collectionId: collection.id, ids };
  }

  it('§5.2 分页返回 items/total/page/pageSize', async () => {
    const { collectionId } = await seed(5);
    const page = await api<EntryPage>(
      ctx.baseUrl,
      'GET',
      `/api/collections/${collectionId}/entries?page=2&pageSize=2`,
    );
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(5);
    expect(page.body.page).toBe(2);
    expect(page.body.pageSize).toBe(2);
    expect(page.body.items).toHaveLength(2);
  });

  it('§5.2 分页参数非法时回退到默认值', async () => {
    const { collectionId } = await seed(3);
    const page = await api<EntryPage>(
      ctx.baseUrl,
      'GET',
      `/api/collections/${collectionId}/entries?page=abc&pageSize=-1`,
    );
    expect(page.body.page).toBe(1);
    expect(page.body.pageSize).toBe(50);
    expect(page.body.items).toHaveLength(3);
  });

  it('§5.2 不存在的合集返回 404', async () => {
    const response = await api<{ error: string }>(
      ctx.baseUrl,
      'GET',
      '/api/collections/不存在/entries',
    );
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('COLLECTION_NOT_FOUND');
  });

  it('§5.2 DELETE /api/entries/:id 返回 204 且条目消失', async () => {
    const { collectionId, ids } = await seed(2);
    const deleted = await api(ctx.baseUrl, 'DELETE', `/api/entries/${ids[0]}`);
    expect(deleted.status).toBe(204);
    const page = await api<EntryPage>(
      ctx.baseUrl,
      'GET',
      `/api/collections/${collectionId}/entries`,
    );
    expect(page.body.total).toBe(1);
    expect(page.body.items[0]?.id).toBe(ids[1]);
  });

  it('§5.2 DELETE /api/entries/:id 不存在返回 404', async () => {
    const response = await api<{ error: string }>(ctx.baseUrl, 'DELETE', '/api/entries/不存在');
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('ENTRY_NOT_FOUND');
  });

  it('§5.2 POST /api/entries/batch-delete 返回 deleted 数', async () => {
    const { ids } = await seed(4);
    const response = await api<{ deleted: number }>(
      ctx.baseUrl,
      'POST',
      '/api/entries/batch-delete',
      { ids: [ids[0], ids[1], '不存在'] },
    );
    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(2);
  });

  it('§5.2 批量删除 ids 非法返回 400', async () => {
    const response = await api<{ error: string }>(
      ctx.baseUrl,
      'POST',
      '/api/entries/batch-delete',
      { ids: [1, 2] },
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('INVALID_REQUEST');
  });

  it('§5.2 DELETE /api/collections/:id/entries 清空但保留合集', async () => {
    const { collectionId } = await seed(3);
    const response = await api<{ deleted: number }>(
      ctx.baseUrl,
      'DELETE',
      `/api/collections/${collectionId}/entries`,
    );
    expect(response.body.deleted).toBe(3);
    const collections = await api<Collection[]>(ctx.baseUrl, 'GET', '/api/collections');
    const target = collections.body.find((item) => item.id === collectionId);
    expect(target).toBeDefined();
    expect(target?.entry_count).toBe(0);
  });

  it('条目字段与 §5.2 契约一致', async () => {
    const { collectionId } = await seed(1);
    const page = await api<EntryPage>(
      ctx.baseUrl,
      'GET',
      `/api/collections/${collectionId}/entries`,
    );
    const entry = page.body.items[0] as Entry;
    expect(Object.keys(entry).sort()).toEqual(
      [
        'collection_id',
        'created_at',
        'id',
        'model_id',
        'source_lang',
        'source_text',
        'target_lang',
        'target_text',
      ].sort(),
    );
    expect(new Date(entry.created_at).toISOString()).toBe(entry.created_at);
  });
});

describe('通用错误形状', () => {
  it('§5 未知 /api 路由返回 JSON 404', async () => {
    const response = await api<{ error: string; message: string }>(
      ctx.baseUrl,
      'GET',
      '/api/不存在',
    );
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('NOT_FOUND');
    expect(typeof response.body.message).toBe('string');
  });

  it('§5 非法 JSON 请求体返回 INVALID_JSON', async () => {
    const response = await fetch(`${ctx.baseUrl}/api/collections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ 不是 JSON',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('INVALID_JSON');
  });
});
