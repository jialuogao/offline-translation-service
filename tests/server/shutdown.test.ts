import { describe, expect, it, vi } from 'vitest';
import { ShutdownController } from '../../apps/server/src/shutdown.js';
import type { LMStudioProcessManager } from '../../apps/server/src/lmstudio/process.js';

/**
 * 关闭编排测试（DESIGN.md §3.4 / §5.4 / §6.4）。
 *
 * 覆盖两类入口的决策差异：HTTP 路径尊重用户选择，信号路径按归属静默决策。
 * 全部用替身，绝不触碰真实 LM Studio。
 */

interface FakeManager {
  manager: LMStudioProcessManager;
  shutdown: ReturnType<typeof vi.fn>;
  status: { running: boolean; startedByUs: boolean; pid?: number };
  setStartedByUs: (value: boolean, pid?: number) => void;
}

function fakeManager(initiallyStartedByUs: boolean): FakeManager {
  const shutdown = vi.fn(async () => ({ ok: true, stillReachable: false }));
  const state = {
    running: true,
    startedByUs: initiallyStartedByUs,
    ...(initiallyStartedByUs ? { pid: 999 } : {}),
  };
  const manager = {
    startup: async () => ({ running: true, startedByUs: state.startedByUs }),
    probeStatus: async () => ({
      running: state.running,
      startedByUs: state.startedByUs,
      ...(state.pid !== undefined ? { pid: state.pid } : {}),
    }),
    status: () => ({
      running: state.running,
      startedByUs: state.startedByUs,
      ...(state.pid !== undefined ? { pid: state.pid } : {}),
    }),
    locate: () => null,
    warmup: async () => ({ attempted: false, ok: false }),
    shutdown,
  } as unknown as LMStudioProcessManager;
  return {
    manager,
    shutdown,
    status: state,
    setStartedByUs: (value: boolean, pid?: number) => {
      state.startedByUs = value;
      if (pid === undefined) delete state.pid;
      else state.pid = pid;
    },
  };
}

describe('§3.4-A 用户主动关闭服务', () => {
  it('startedByUs=true：按 PID 关闭，忽略 closeLmStudio=false', async () => {
    const fake = fakeManager(true);
    const controller = new ShutdownController({
      processManager: fake.manager,
      closeResources: () => undefined,
      exit: () => undefined,
      gracePeriodMs: 0,
    });

    const result = await controller.shutdown({ closeLmStudio: false });
    expect(fake.shutdown).toHaveBeenCalledWith({ force: false });
    expect(result.lmStudioClosed).toBe(true);
  });

  it('startedByUs=false 且未要求关闭：保持 LM Studio 运行', async () => {
    const fake = fakeManager(false);
    const closeResources = vi.fn();
    const controller = new ShutdownController({
      processManager: fake.manager,
      closeResources,
      exit: () => undefined,
      gracePeriodMs: 0,
    });

    const result = await controller.shutdown({ closeLmStudio: false });
    expect(fake.shutdown).not.toHaveBeenCalled();
    expect(result.lmStudioClosed).toBe(false);
    expect(closeResources).toHaveBeenCalledTimes(1);
  });

  it('startedByUs=false 且用户确认：force 尽力关闭外部实例', async () => {
    const fake = fakeManager(false);
    const controller = new ShutdownController({
      processManager: fake.manager,
      closeResources: () => undefined,
      exit: () => undefined,
      gracePeriodMs: 0,
    });

    const result = await controller.shutdown({ closeLmStudio: true });
    expect(fake.shutdown).toHaveBeenCalledWith({ force: true });
    expect(result.lmStudioClosed).toBe(true);
  });

  it('关闭 LM Studio 失败不影响关库与退出（§6.4 允许失败）', async () => {
    const fake = fakeManager(true);
    fake.shutdown.mockRejectedValueOnce(new Error('taskkill 失败'));
    const closeResources = vi.fn();
    const exits: number[] = [];
    const controller = new ShutdownController({
      processManager: fake.manager,
      closeResources,
      exit: (code) => exits.push(code),
      gracePeriodMs: 0,
    });

    await controller.shutdown({});
    expect(closeResources).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(exits).toEqual([0]);
  });

  it('重复调用只执行一次停机', async () => {
    const fake = fakeManager(true);
    const closeResources = vi.fn();
    const controller = new ShutdownController({
      processManager: fake.manager,
      closeResources,
      exit: () => undefined,
      gracePeriodMs: 0,
    });

    await controller.shutdown({});
    await controller.shutdown({});
    expect(closeResources).toHaveBeenCalledTimes(1);
  });
});

describe('§3.4-B 信号路径', () => {
  it('startedByUs=true：按 PID 关闭', async () => {
    const fake = fakeManager(true);
    const controller = new ShutdownController({
      processManager: fake.manager,
      closeResources: () => undefined,
      exit: () => undefined,
      gracePeriodMs: 0,
    });

    controller.handleSignal('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.shutdown).toHaveBeenCalledWith({ force: false });
  });

  it('startedByUs=false：不关外部 LM Studio，只关库退出', async () => {
    const fake = fakeManager(false);
    const closeResources = vi.fn();
    const controller = new ShutdownController({
      processManager: fake.manager,
      closeResources,
      exit: () => undefined,
      gracePeriodMs: 0,
    });

    controller.handleSignal('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fake.shutdown).not.toHaveBeenCalled();
    expect(closeResources).toHaveBeenCalledTimes(1);
  });

  it('SIGINT 退出码为 130，SIGTERM 为 143', async () => {
    const exits: number[] = [];
    const first = new ShutdownController({
      processManager: fakeManager(false).manager,
      closeResources: () => undefined,
      exit: (code) => exits.push(code),
      gracePeriodMs: 0,
    });
    first.handleSignal('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 5));
    first.handleSignal('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(exits).toEqual([130]);
  });
});
