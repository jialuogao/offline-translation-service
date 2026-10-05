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

describe('POST /api/lmstudio/shutdown', () => {
  it('外部实例且未 force：返回 409 让前端弹窗确认（§5.4 / §6.4）', async () => {
    const response = await api<{ error: string }>(
      ctx.baseUrl,
      'POST',
      '/api/lmstudio/shutdown',
      {},
    );
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('LMSTUDIO_NOT_OWNED');
    // 只关 LM Studio，不关后端。
    expect(ctx.exitCalls).toHaveLength(0);
  });

  it('本会话启动的实例：直接关闭，不要求 force', async () => {
    const terminateCalls: number[] = [];
    // 指向一个没有监听者的端口：启动路径会走 spawn（归属=本会话），
    // 就绪探测超时为 0，因此 startup 立即返回但已记录 PID。
    const owned = await createTestContext({
      lmStudioBaseUrl: 'http://127.0.0.1:65530',
      spawnOwnedProcess: true,
      terminate: async (pid) => {
        terminateCalls.push(pid);
        return true;
      },
    });
    try {
      const status = await api<{ startedByUs: boolean; pid?: number }>(
        owned.baseUrl,
        'GET',
        '/api/lmstudio/status',
      );
      expect(status.body.startedByUs).toBe(true);

      const response = await api<{ ok: boolean }>(
        owned.baseUrl,
        'POST',
        '/api/lmstudio/shutdown',
        {},
      );
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(terminateCalls).toEqual([status.body.pid]);
    } finally {
      await owned.close();
    }
  });
});

describe('POST /api/shutdown', () => {
  it('先返回 { ok: true }，再关库并退出，且不动外部 LM Studio', async () => {
    const response = await api<{ ok: boolean }>(ctx.baseUrl, 'POST', '/api/shutdown', {
      closeLmStudio: false,
    });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);

    await waitFor(() => ctx.exitCalls.length === 1, { label: '服务完成停机' });
    expect(ctx.exitCalls).toEqual([0]);
    // 外部 LM Studio（Mock）必须仍在运行。
    expect((await fetch(`${mock.baseUrl}/v1/models`)).status).toBe(200);
  });

  it('closeLmStudio=true 时走外部实例关闭流程（允许失败）并仍然退出', async () => {
    // 外部实例关闭只能"尽力"：Mock 进程不会被真的 taskkill，故 ok 允许为 false。
    const response = await api<{ ok: boolean }>(ctx.baseUrl, 'POST', '/api/shutdown', {
      closeLmStudio: true,
    });
    expect(response.status).toBe(200);
    expect(typeof response.body.ok).toBe('boolean');
    await waitFor(() => ctx.exitCalls.length === 1, { label: '服务完成停机' });
    expect((await fetch(`${mock.baseUrl}/v1/models`)).status).toBe(200);
  });

  it('closeLmStudio 非布尔值返回 400', async () => {
    const response = await api<{ error: string }>(ctx.baseUrl, 'POST', '/api/shutdown', {
      closeLmStudio: 'yes',
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('INVALID_REQUEST');
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
