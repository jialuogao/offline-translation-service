import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Collection } from '@ots/contracts';
import { startMockServer, type MockServer } from '../mock-lmstudio/server.js';
import { createTestContext, type TestContext } from '../helpers/context.js';
import { api, readSse, waitFor } from '../helpers/http.js';

/** §5.4 关闭与状态端点的接口层断言（不触碰真实 LM Studio）。 */

let mock: MockServer;
let ctx: TestContext;

beforeEach(async () => {
  mock = await startMockServer({ chunkSize: 6 });
  ctx = await createTestContext({ lmStudioBaseUrl: mock.baseUrl });
});

afterEach(async () => {
  await ctx.close();
  await mock.close();
});

describe('POST /api/lmstudio/unload', () => {
  it('卸载已驻留的目标模型，不关后端、不关 LM Studio（§6.4）', async () => {
    await ctx.close();
    ctx = await createTestContext({
      lmStudioBaseUrl: mock.baseUrl,
      modelId: '目标模型',
      loadedInstances: ['目标模型', '别的模型'],
    });
    const response = await api<{ ok: boolean; unloaded: string[] }>(
      ctx.baseUrl,
      'POST',
      '/api/lmstudio/unload',
      {},
    );
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.unloaded).toEqual(['目标模型']);
    // 后端仍在运行。
    expect(ctx.exitCalls).toHaveLength(0);
    expect((await fetch(`${mock.baseUrl}/v1/models`)).status).toBe(200);
  });

  it('目标未驻留时 ok=true 且 unloaded 为空', async () => {
    await ctx.close();
    ctx = await createTestContext({
      lmStudioBaseUrl: mock.baseUrl,
      modelId: '目标模型',
      loadedInstances: ['别的模型'],
    });
    const response = await api<{ ok: boolean; unloaded: string[] }>(
      ctx.baseUrl,
      'POST',
      '/api/lmstudio/unload',
      {},
    );
    expect(response.body).toMatchObject({ ok: true, unloaded: [] });
  });

  it('卸载失败返回 200 + ok=false + 原因（不是服务器错误）', async () => {
    await ctx.close();
    ctx = await createTestContext({
      lmStudioBaseUrl: mock.baseUrl,
      lmsFailure: 'timeout',
    });
    const response = await api<{ ok: boolean; reason: string }>(
      ctx.baseUrl,
      'POST',
      '/api/lmstudio/unload',
      {},
    );
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(false);
    expect(response.body.reason).toBeTruthy();
    expect(ctx.exitCalls).toHaveLength(0);
  });
});

describe('POST /api/shutdown', () => {
  it('先返回 { ok: true }，再卸载模型、关库并退出（ok 仅表示已受理）', async () => {
    const response = await api<{ ok: boolean }>(ctx.baseUrl, 'POST', '/api/shutdown', {});
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);

    await waitFor(() => ctx.exitCalls.length === 1, { label: '服务完成停机' });
    expect(ctx.exitCalls).toEqual([0]);
    // LM Studio 服务器保持运行——本设计永不终止它。
    expect((await fetch(`${mock.baseUrl}/v1/models`)).status).toBe(200);
  });
});

describe('§9.3 SSE 帧格式', () => {
  it('每个事件都是 `event: <name>\\ndata: <json>\\n\\n`', async () => {
    const target = (
      await api<Collection[]>(ctx.baseUrl, 'GET', '/api/collections')
    ).body[0]?.id as string;
    const response = await readSse(ctx.baseUrl, '/api/translate/stream', {
      collection_id: target,
      source_lang: 'zh',
      target_lang: 'en',
      source_text: '帧格式',
    });
    const blocks = response.text.split('\n\n').filter((block) => block.trim() !== '');
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      const lines = block.split('\n');
      expect(lines[0]?.startsWith('event: ')).toBe(true);
      expect(lines[1]?.startsWith('data: ')).toBe(true);
      expect(lines).toHaveLength(2);
      expect(['delta', 'done', 'error']).toContain(lines[0]?.slice('event: '.length) ?? '');
      // data 必须是合法 JSON。
      expect(() => JSON.parse(lines[1]?.slice('data: '.length) ?? '')).not.toThrow();
    }
    const doneBlock = blocks[blocks.length - 1] ?? '';
    expect(doneBlock.startsWith('event: done')).toBe(true);
  });
});
