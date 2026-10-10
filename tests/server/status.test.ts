import { describe, expect, it } from 'vitest';
import { ServiceHealth } from '../../apps/server/src/health.js';
import { createServiceStatusRouter } from '../../apps/server/src/routes/status.js';
import { api } from '../helpers/http.js';
import { createTestContext } from '../helpers/context.js';

/**
 * 服务健康状态（DESIGN.md §5.4 `GET /api/service/status`）。
 *
 * 要点：
 * - 模块状态机 `loading → ok / error`；`pending` 只要有模块在 loading 就为 true。
 * - 这是**统一反馈端点**：db / storage / lmstudio 都会出现在快照里，不局限于模型。
 */

describe('ServiceHealth 状态机', () => {
  it('初始为全 unknown：pending=false、ok=false', () => {
    const health = new ServiceHealth();
    const snap = health.snapshot();
    expect(snap.pending).toBe(false);
    expect(snap.ok).toBe(false);
    expect(Object.keys(snap.modules)).toEqual([]);
  });

  it('一个模块 loading 时 pending=true', () => {
    const health = new ServiceHealth();
    health.begin('db');
    const snap = health.snapshot();
    expect(snap.pending).toBe(true);
    expect(snap.ok).toBe(true);
  });

  it('全部 succeed 后 pending=false、ok=true', () => {
    const health = new ServiceHealth();
    health.begin('db');
    health.succeed('db');
    health.begin('storage');
    health.succeed('storage');
    const snap = health.snapshot();
    expect(snap.pending).toBe(false);
    expect(snap.ok).toBe(true);
    expect(snap.errors).toEqual([]);
  });

  it('一个模块 error 时 ok=false 且 errors 聚合其 message', () => {
    const health = new ServiceHealth();
    health.begin('lmstudio');
    health.fail('lmstudio', '模型加载失败（已尝试 3 次）');
    const snap = health.snapshot();
    expect(snap.ok).toBe(false);
    expect(snap.pending).toBe(false);
    expect(snap.errors).toEqual([{ module: 'lmstudio', message: '模型加载失败（已尝试 3 次）' }]);
  });

  it('有模块仍在 loading 时，即使别处 error 也 pending=true（等所有模块落定）', () => {
    const health = new ServiceHealth();
    health.begin('db');
    health.succeed('db');
    health.begin('lmstudio');
    health.fail('lmstudio', '模型不可用');
    health.begin('storage'); // 仍在加载中
    const snap = health.snapshot();
    expect(snap.pending).toBe(true);
    expect(snap.ok).toBe(false);
  });

  it('retry 记录 attempts 递增并回到 loading', () => {
    const health = new ServiceHealth();
    health.begin('lmstudio');
    health.setMaxAttempts('lmstudio', 3);
    health.retry('lmstudio', '第 1 轮失败');
    expect(health.snapshot().modules.lmstudio).toMatchObject({
      state: 'loading',
      attempts: 1,
      maxAttempts: 3,
    });
    health.retry('lmstudio', '第 2 轮失败');
    expect(health.snapshot().modules.lmstudio?.attempts).toBe(2);
  });
});

describe('GET /api/service/status', () => {
  it('返回 ServiceStatus 形状（db/storage 就绪时 ok=true）', async () => {
    const health = new ServiceHealth();
    health.begin('db');
    health.succeed('db');
    health.begin('storage');
    health.succeed('storage');
    const ctx = await createTestContext({ lmStudioBaseUrl: 'http://127.0.0.1:1', health });
    try {
      const res = await api(ctx.baseUrl, 'GET', '/api/service/status');
      expect(res.status).toBe(200);
      const body = res.body as {
        ok: boolean;
        pending: boolean;
        modules: Record<string, { state: string }>;
        errors: unknown[];
      };
      expect(body.ok).toBe(true);
      expect(body.pending).toBe(false);
      expect(body.modules['db']?.state).toBe('ok');
      expect(body.modules['storage']?.state).toBe('ok');
      expect(body.errors).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  it('lmstudio 模块失败时 ok=false 且 errors 反映原因', async () => {
    const health = new ServiceHealth();
    health.begin('db');
    health.succeed('db');
    health.begin('storage');
    health.succeed('storage');
    health.begin('lmstudio');
    health.fail('lmstudio', 'LM Studio 服务器不可用');
    const ctx = await createTestContext({ lmStudioBaseUrl: 'http://127.0.0.1:1', health });
    try {
      const res = await api(ctx.baseUrl, 'GET', '/api/service/status');
      const body = res.body as {
        ok: boolean;
        pending: boolean;
        errors: Array<{ module: string; message: string }>;
      };
      expect(body.ok).toBe(false);
      expect(body.pending).toBe(false);
      expect(body.errors).toContainEqual({ module: 'lmstudio', message: 'LM Studio 服务器不可用' });
    } finally {
      await ctx.close();
    }
  });
});
