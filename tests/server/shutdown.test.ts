import { describe, expect, it, vi } from 'vitest';
import { ShutdownController } from '../../apps/server/src/shutdown.js';
import type { LMStudioProcessManager } from '../../apps/server/src/lmstudio/process.js';
import type { Server } from 'node:http';

/**
 * 关闭编排测试（DESIGN.md §3.4 / §6.4，2026-10-05 重新决定后的行为）。
 *
 * 停机序列：**卸载模型 → 停止接受新连接 → 关库 → 退出**。
 * 本控制器**没有任何**进程终止路径，因此这里也不存在归属（startedByUs）
 * 分支——HTTP 路径与信号路径执行完全相同的序列，只有退出码不同。
 */

interface FakeManager {
  manager: LMStudioProcessManager;
  unload: ReturnType<typeof vi.fn>;
}

function fakeManager(
  outcome: { ok: boolean; unloaded?: string[]; residual?: string[]; reason?: string } = { ok: true },
): FakeManager {
  const unload = vi.fn(async () => ({
    ok: outcome.ok,
    unloaded: outcome.unloaded ?? (outcome.ok ? ['目标模型'] : []),
    residual: outcome.residual ?? [],
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  }));
  const manager = {
    startup: async () => ({ running: true }),
    probeStatus: async () => ({ running: true }),
    locate: () => null,
    warmup: async () => ({ attempted: false, ok: false }),
    unload,
  } as unknown as LMStudioProcessManager;
  return { manager, unload };
}

function makeController(fake: FakeManager, overrides: Record<string, unknown> = {}) {
  return new ShutdownController({
    processManager: fake.manager,
    closeResources: () => undefined,
    exit: () => undefined,
    gracePeriodMs: 0,
    ...overrides,
  } as ConstructorParameters<typeof ShutdownController>[0]);
}

describe('§3.4 / §6.4 停机序列', () => {
  it('卸载模型后关库，且 LM Studio 进程完全不受影响', async () => {
    const fake = fakeManager();
    const closeResources = vi.fn();
    const controller = makeController(fake, { closeResources });

    const result = await controller.shutdown();

    expect(fake.unload).toHaveBeenCalledTimes(1);
    expect(result.modelUnloaded).toBe(true);
    expect(closeResources).toHaveBeenCalledTimes(1);
    // 没有 closeLmStudio 参数，也没有归属分支：唯一动作就是 unload。
    expect(fake.unload).toHaveBeenCalledWith();
  });

  it('顺序：先卸载、再停止接受新连接、最后关库', async () => {
    const order: string[] = [];
    const fake = {
      manager: {
        unload: async () => {
          order.push('unload');
          return { ok: true, unloaded: [], residual: [] };
        },
        startup: async () => ({ running: true }),
        probeStatus: async () => ({ running: true }),
        locate: () => null,
        warmup: async () => ({ attempted: false, ok: false }),
      } as unknown as LMStudioProcessManager,
    };
    const controller = new ShutdownController({
      processManager: fake.manager,
      closeResources: () => order.push('closeResources'),
      exit: () => undefined,
      gracePeriodMs: 0,
    });
    controller.attachServer({ close: () => order.push('stopAccepting') } as unknown as Server);

    await controller.shutdown();
    expect(order).toEqual(['unload', 'stopAccepting', 'closeResources']);
  });

  it('卸载失败仍要关库并退出，且如实回报原因（§6.4：残留模型远好过杀进程）', async () => {
    const fake = fakeManager({ ok: false, reason: 'lms ps 复核失败' });
    const closeResources = vi.fn();
    const exits: number[] = [];
    const controller = makeController(fake, {
      closeResources,
      exit: (code: number) => exits.push(code),
    });

    const result = await controller.shutdown();

    expect(result.modelUnloaded).toBe(false);
    expect(result.reason).toBe('lms ps 复核失败');
    expect(closeResources).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(exits).toEqual([0]);
  });

  it('unload 抛异常时也只降级，不影响关库与退出', async () => {
    const fake = fakeManager();
    fake.unload.mockRejectedValueOnce(new Error('boom'));
    const closeResources = vi.fn();
    const controller = makeController(fake, { closeResources });

    const result = await controller.shutdown();
    expect(result.modelUnloaded).toBe(false);
    expect(result.reason).toContain('boom');
    expect(closeResources).toHaveBeenCalledTimes(1);
  });

  it('复核发现残余实例时 modelUnloaded=false（内存没真正释放）', async () => {
    const fake = fakeManager({ ok: false, unloaded: ['目标模型'], residual: ['目标模型:2'] });
    const result = await makeController(fake).shutdown();
    expect(result.modelUnloaded).toBe(false);
    expect(result.residual).toEqual(['目标模型:2']);
  });

  it('重复调用只执行一次停机（幂等闸门）', async () => {
    const fake = fakeManager();
    const closeResources = vi.fn();
    const controller = makeController(fake, { closeResources });

    await controller.shutdown();
    await controller.shutdown();
    expect(fake.unload).toHaveBeenCalledTimes(1);
    expect(closeResources).toHaveBeenCalledTimes(1);
  });

  it('关闭资源抛错不影响退出', async () => {
    const fake = fakeManager();
    const exits: number[] = [];
    const controller = makeController(fake, {
      closeResources: () => {
        throw new Error('db 关闭失败');
      },
      exit: (code: number) => exits.push(code),
    });

    await controller.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(exits).toEqual([0]);
  });
});

describe('§3.4-B 信号路径', () => {
  it('SIGINT 与 HTTP 路径执行同一序列，仅退出码不同', async () => {
    const fake = fakeManager();
    const exits: number[] = [];
    const controller = makeController(fake, { exit: (code: number) => exits.push(code) });

    controller.handleSignal('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fake.unload).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([130]);
  });

  it('SIGTERM 退出码为 143', async () => {
    const exits: number[] = [];
    const controller = makeController(fakeManager(), {
      exit: (code: number) => exits.push(code),
    });
    controller.handleSignal('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(exits).toEqual([143]);
  });

  it('两个信号都到达时只执行一次', async () => {
    const fake = fakeManager();
    const exits: number[] = [];
    const controller = makeController(fake, { exit: (code: number) => exits.push(code) });

    controller.handleSignal('SIGINT');
    controller.handleSignal('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fake.unload).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([130]);
  });
});