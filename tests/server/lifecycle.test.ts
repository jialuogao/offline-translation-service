import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LMStudioProcessManager, serverStartArgs } from '../../apps/server/src/lmstudio/process.js';
import { build, locateLmStudio } from '../../apps/server/src/lmstudio/locate.js';
import { instancesOf, parseLoadedIdentifiers } from '../../apps/server/src/lmstudio/lmsCli.js';
import {
  findPidListeningOnPort,
  isLmStudioProcess,
} from '../../apps/server/src/lmstudio/winProcess.js';
import { createFakeAdapter } from '../helpers/fakeAdapter.js';
import { scratchDir, listenOnSafePort } from '../helpers/paths.js';

/**
 * LM Studio 生命周期测试（DESIGN.md §6）。
 *
 * 安全红线（AGENTS.md）：
 * - `lms` 全程由内存替身应答，测试**绝不**真的执行 `lms`。
 * - §6.4 取消了一切进程终止，因此这里也**没有任何** taskkill 或按 PID 清理；
 *   `winProcess` 的测试只验证**查询**函数。
 */

type ManagerOptions = ConstructorParameters<typeof LMStudioProcessManager>[0];

const MODEL = '目标模型';

/** `lms` 的内存替身：回答 `ps --json`，把 `unload <id>` 落实为从列表移除。 */
function fakeLms(loaded: string[], calls?: string[][]) {
  return async (_exe: string, args: string[]): Promise<{
    ok: boolean; code: number; stdout: string; stderr: string; timedOut: boolean;
  }> => {
    calls?.push(args);
    if (args[0] === 'ps') {
      return {
        ok: true, code: 0, timedOut: false, stderr: '',
        stdout: JSON.stringify(loaded.map((id) => ({ identifier: id }))),
      };
    }
    if (args[0] === 'unload' && args[1] !== undefined) {
      // 实测：退出码恒为 0；模型不存在时输出 Model Not Found，退出码仍是 0。
      const index = loaded.indexOf(args[1]);
      if (index >= 0) loaded.splice(index, 1);
      return {
        ok: true, code: 0, timedOut: false, stderr: '',
        stdout: index >= 0 ? `Model "${args[1]}" unloaded.` : 'Model Not Found',
      };
    }
    return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false };
  };
}

function managerOptions(overrides: Partial<ManagerOptions> = {}): ManagerOptions {
  return {
    adapter: createFakeAdapter({ reachable: true }) as unknown as ManagerOptions['adapter'],
    baseUrl: 'http://127.0.0.1:1234',
    startupTimeoutMs: 1_000,
    probeIntervalMs: 5,
    showConsole: false,
    autoStart: true,
    exeOverride: '',
    startArgs: [],
    modelId: MODEL,
    unloadTimeoutMs: 1_000,
    listTimeoutMs: 1_000,
    retryAttempts: 3,
    retryIntervalMs: 1,
    loadWaitTimeoutMs: 500,
    log: () => {
      /* 静音 */
    },
    ...overrides,
  };
}

describe('§3.3 启动流程', () => {
  it('端点已可达时直接使用，且不定位可执行文件', async () => {
    const locate = vi.fn(() => null);
    const manager = new LMStudioProcessManager(
      managerOptions({
        adapter: createFakeAdapter({ reachable: true }) as unknown as ManagerOptions['adapter'],
        locate: locate as unknown as ManagerOptions['locate'],
      }),
    );
    await expect(manager.startup()).resolves.toEqual({ running: true });
    expect(locate).not.toHaveBeenCalled();
  });

  it('禁用自动启动时，不可达也不定位、不启动', async () => {
    const locate = vi.fn(() => null);
    const manager = new LMStudioProcessManager(
      managerOptions({
        adapter: createFakeAdapter({ reachable: false }) as unknown as ManagerOptions['adapter'],
        autoStart: false,
        locate: locate as unknown as ManagerOptions['locate'],
      }),
    );
    await expect(manager.startup()).resolves.toEqual({ running: false });
    expect(locate).not.toHaveBeenCalled();
  });

  it('定位失败时降级：不抛错，running=false（§6.2 说明）', async () => {
    const manager = new LMStudioProcessManager(
      managerOptions({
        adapter: createFakeAdapter({ reachable: false }) as unknown as ManagerOptions['adapter'],
        locate: (() => null) as unknown as ManagerOptions['locate'],
      }),
    );
    await expect(manager.startup()).resolves.toEqual({ running: false });
  });

  it('只定位到桌面版时不 spawn（桌面版没有 lms 子命令，§6.2/§6.3）', async () => {
    const runLms = vi.fn(fakeLms([]));
    const manager = new LMStudioProcessManager(
      managerOptions({
        adapter: createFakeAdapter({ reachable: false }) as unknown as ManagerOptions['adapter'],
        startupTimeoutMs: 0,
        locate: (() => ({
          path: 'C:\\x\\LM Studio.exe', kind: 'desktop' as const, source: 'test', args: [],
        })) as unknown as ManagerOptions['locate'],
        runLms: runLms as unknown as ManagerOptions['runLms'],
      }),
    );
    await expect(manager.startup()).resolves.toEqual({ running: false });
    expect(runLms).not.toHaveBeenCalled();
  });

  it('拼装启动参数时补 -p <端口> 与 --bind 127.0.0.1（§6.3 实测：不传 -p 会沿用上次的端口）', () => {
    const args = serverStartArgs('http://127.0.0.1:8123', ['server', 'start']);
    expect(args).toEqual(['server', 'start', '-p', '8123', '--bind', '127.0.0.1']);
  });

  it('调用方已显式提供 -p / --bind 时不重复追加', () => {
    const args = serverStartArgs('http://127.0.0.1:8123', ['server', 'start', '-p', '9999']);
    expect(args.filter((a) => a === '-p')).toHaveLength(1);
    expect(args[args.indexOf('-p') + 1]).toBe('9999');
    expect(args.filter((a) => a === '--bind')).toHaveLength(1);
  });

  it('baseUrl 无法解析端口时不追加 -p，但仍固定 --bind', () => {
    const args = serverStartArgs('不是 URL', ['server', 'start']);
    expect(args).toEqual(['server', 'start', '--bind', '127.0.0.1']);
  });
});

describe('§6.4 模型卸载', () => {
  it('未配置模型时不卸载，也不做任何进程操作', async () => {
    const runLms = vi.fn(fakeLms([]));
    const manager = new LMStudioProcessManager(
      managerOptions({
        modelId: '   ',
        runLms: runLms as unknown as ManagerOptions['runLms'],
        locate: (() => null) as unknown as ManagerOptions['locate'],
      }),
    );
    const result = await manager.unload();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('LMSTUDIO_MODEL');
    expect(runLms).not.toHaveBeenCalled();
  });

  it('找不到 lms CLI 时降级：什么都不做，不终止进程', async () => {
    const runLms = vi.fn(fakeLms([MODEL]));
    const manager = new LMStudioProcessManager(
      managerOptions({
        locate: (() => null) as unknown as ManagerOptions['locate'],
        runLms: runLms as unknown as ManagerOptions['runLms'],
      }),
    );
    const result = await manager.unload();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('未找到 lms CLI');
    expect(runLms).not.toHaveBeenCalled();
  });

  it('目标模型未驻留时视为成功，且不发起 unload', async () => {
    const calls: string[][] = [];
    const manager = new LMStudioProcessManager(
      managerOptions({
        runLms: fakeLms(['别的模型'], calls) as unknown as ManagerOptions['runLms'],
        locate: (() => ({ path: 'lms.exe', kind: 'lms-cli' as const, source: 't', args: [] })) as unknown as ManagerOptions['locate'],
      }),
    );
    await expect(manager.unload()).resolves.toEqual({ ok: true, unloaded: [], residual: [] });
    expect(calls.filter((c) => c[0] === 'unload')).toEqual([]);
  });

  it('精确卸载目标模型，且不碰其它模型', async () => {
    const loaded = [MODEL, '别的模型'];
    const calls: string[][] = [];
    const manager = new LMStudioProcessManager(
      managerOptions({
        runLms: fakeLms(loaded, calls) as unknown as ManagerOptions['runLms'],
        locate: (() => ({ path: 'lms.exe', kind: 'lms-cli' as const, source: 't', args: [] })) as unknown as ManagerOptions['locate'],
      }),
    );
    const result = await manager.unload();
    expect(result.ok).toBe(true);
    expect(result.unloaded).toEqual([MODEL]);
    expect(loaded).toEqual(['别的模型']);
    expect(calls.filter((c) => c[0] === 'unload')).toEqual([['unload', MODEL]]);
  });

  it('目标模型有多个实例时全部卸载，不留残余', async () => {
    const loaded = [MODEL, `${MODEL}:2`, `${MODEL}:3`, '别的模型'];
    const manager = new LMStudioProcessManager(
      managerOptions({
        runLms: fakeLms(loaded) as unknown as ManagerOptions['runLms'],
        locate: (() => ({ path: 'lms.exe', kind: 'lms-cli' as const, source: 't', args: [] })) as unknown as ManagerOptions['locate'],
      }),
    );
    const result = await manager.unload();
    expect(result.ok).toBe(true);
    expect(result.unloaded).toEqual([MODEL, `${MODEL}:2`, `${MODEL}:3`]);
    expect(loaded).toEqual(['别的模型']);
  });

  it('复核发现仍有实例驻留时 ok=false 并回报 residual（退出码不可信，只能靠 ps 复核）', async () => {
    // 替身对 unload 装作成功但实际不移除 —— 模拟"退出码 0 但没真卸掉"。
    const calls: string[][] = [];
    const manager = new LMStudioProcessManager(
      managerOptions({
        runLms: (async (_exe: string, args: string[]) => {
          calls.push(args);
          if (args[0] === 'ps') {
            return {
              ok: true, code: 0, timedOut: false, stderr: '',
              stdout: JSON.stringify([{ identifier: MODEL }]),
            };
          }
          return { ok: true, code: 0, stdout: 'unloaded', stderr: '', timedOut: false };
        }) as unknown as ManagerOptions['runLms'],
        locate: (() => ({ path: 'lms.exe', kind: 'lms-cli' as const, source: 't', args: [] })) as unknown as ManagerOptions['locate'],
      }),
    );
    const result = await manager.unload();
    expect(result.ok).toBe(false);
    expect(result.residual).toEqual([MODEL]);
    // 复核必须真的发生过：ps → unload → ps
    expect(calls).toEqual([['ps', '--json'], ['unload', MODEL], ['ps', '--json']]);
  });

  it('lms 超时即降级，不阻塞停机', async () => {
    const manager = new LMStudioProcessManager(
      managerOptions({
        runLms: (async () => ({
          ok: false, code: null, stdout: '', stderr: '', timedOut: true,
        })) as unknown as ManagerOptions['runLms'],
        locate: (() => ({ path: 'lms.exe', kind: 'lms-cli' as const, source: 't', args: [] })) as unknown as ManagerOptions['locate'],
      }),
    );
    const result = await manager.unload();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('超时');
  });
});

describe('lmsCli 解析', () => {
  it('空数组与垃圾输出都不会被当成"已卸载干净"', () => {
    expect(parseLoadedIdentifiers('[]')).toEqual([]);
    expect(parseLoadedIdentifiers('')).toEqual([]);
    expect(parseLoadedIdentifiers('not json')).toEqual([]);
    expect(parseLoadedIdentifiers('[{"identifier":"m"},{"identifier":" m:2 "}]')).toEqual(['m', 'm:2']);
  });

  it('instancesOf 匹配裸 id 与 :N 实例，但不会误伤同前缀的其它模型', () => {
    expect(instancesOf(['m', 'm:2', 'm:3', 'm2', 'model-x'], 'm')).toEqual(['m', 'm:2', 'm:3']);
  });
});

describe('§13-5 模型预热', () => {
  it('有已驻留模型时选中它并跳过加载（不新建实例）', async () => {
    const adapter = createFakeAdapter({
      reachable: true,
      models: [
        { id: '未加载', state: 'not-loaded' },
        { id: '已加载', state: 'loaded' },
      ],
    });
    const manager = new LMStudioProcessManager(
      managerOptions({ adapter: adapter as unknown as ManagerOptions['adapter'] }),
    );
    await expect(manager.warmup()).resolves.toEqual({
      attempted: false,
      model: '已加载',
      ok: true,
      alreadyResident: true,
    });
    expect(adapter.loadCalls).toEqual([]);
  });

  it('显式指定一个未被加载的模型时才真的加载', async () => {
    const adapter = createFakeAdapter({
      reachable: true,
      models: [
        { id: '未加载', state: 'not-loaded' },
        { id: '已加载', state: 'loaded' },
      ],
    });
    const manager = new LMStudioProcessManager(
      managerOptions({ adapter: adapter as unknown as ManagerOptions['adapter'] }),
    );
    await expect(manager.warmup('未加载')).resolves.toEqual({
      attempted: true,
      model: '未加载',
      ok: true,
      alreadyResident: false,
    });
    expect(adapter.loadCalls).toEqual(['未加载']);
  });

  it('回归：模型已驻留时绝不再调 load（load 会新建实例，吃光显存）', async () => {
    const adapter = createFakeAdapter({
      reachable: true,
      models: [{ id: '已驻留模型', state: 'loaded' }],
    });
    const manager = new LMStudioProcessManager(
      managerOptions({ adapter: adapter as unknown as ManagerOptions['adapter'] }),
    );

    await expect(manager.warmup()).resolves.toEqual({
      attempted: false,
      model: '已驻留模型',
      ok: true,
      alreadyResident: true,
    });
    // 显式指定同一模型也必须跳过。
    await expect(manager.warmup('已驻留模型')).resolves.toMatchObject({
      attempted: false,
      alreadyResident: true,
    });
    expect(adapter.loadCalls).toEqual([]);
  });

  it('回归：`:N` 实例已驻留时同样跳过（裸 id 与实例 id 视为同一个模型）', async () => {
    const adapter = createFakeAdapter({
      reachable: true,
      models: [
        { id: '目标模型', state: 'not-loaded' },
        { id: '目标模型:2', state: 'loaded' },
      ],
    });
    const manager = new LMStudioProcessManager(
      managerOptions({ adapter: adapter as unknown as ManagerOptions['adapter'] }),
    );
    await expect(manager.warmup('目标模型')).resolves.toMatchObject({
      attempted: false,
      alreadyResident: true,
    });
    expect(adapter.loadCalls).toEqual([]);
  });

  it('未驻留时才真正加载，且第二次预热不会再加载', async () => {
    const adapter = createFakeAdapter({
      reachable: true,
      models: [{ id: '冷模型', state: 'not-loaded' }],
    });
    const manager = new LMStudioProcessManager(
      managerOptions({ adapter: adapter as unknown as ManagerOptions['adapter'] }),
    );
    await expect(manager.warmup('冷模型')).resolves.toMatchObject({
      attempted: true,
      ok: true,
      alreadyResident: false,
    });
    await expect(manager.warmup('冷模型')).resolves.toMatchObject({
      attempted: false,
      alreadyResident: true,
    });
    expect(adapter.loadCalls).toEqual(['冷模型']);
  });

  it('没有可用模型时不尝试加载', async () => {
    const adapter = createFakeAdapter({ reachable: true, models: [] });
    const manager = new LMStudioProcessManager(
      managerOptions({ adapter: adapter as unknown as ManagerOptions['adapter'] }),
    );
    await expect(manager.warmup()).resolves.toMatchObject({ attempted: false, ok: false });
    expect(adapter.loadCalls).toEqual([]);
  });

  it('显式指定 model id 时直接加载', async () => {
    const adapter = createFakeAdapter({ reachable: true });
    const manager = new LMStudioProcessManager(
      managerOptions({ adapter: adapter as unknown as ManagerOptions['adapter'] }),
    );
    await expect(manager.warmup('指定模型')).resolves.toMatchObject({
      attempted: true,
      model: '指定模型',
      ok: true,
    });
  });
});

describe('§6.2 定位 lmstudio / lms', () => {
  it('LMSTUDIO_EXE 覆盖优先，且必须是存在的文件', () => {
    const dir = scratchDir('locate');
    const fake = path.join(dir, 'fake-lmstudio.exe');
    try {
      fs.writeFileSync(fake, 'stub');
      expect(locateLmStudio({ override: fake })?.path).toBe(fake);
      expect(locateLmStudio({ override: path.join(dir, '不存在.exe') })).toBeNull();
    } finally {
      // scratch 清理：否则这个假可执行文件会留在 `.temp/tests/locate/`。
      fs.rmSync(fake, { force: true });
    }
  });

  it('lms.exe 走 `server start`，桌面版不带子命令（§6.3 实测）', () => {
    const cli = build('C:\\x\\lms.exe', 'test');
    expect(cli.kind).toBe('lms-cli');
    expect(cli.args).toEqual(['server', 'start']);

    const desktop = build('C:\\x\\LM Studio.exe', 'test');
    expect(desktop.kind).toBe('desktop');
    expect(desktop.args).toEqual([]);
  });

  it('显式 startArgs 覆盖默认参数', () => {
    expect(build('C:\\x\\lms.exe', 'test', ['server', 'status']).args).toEqual([
      'server',
      'status',
    ]);
  });

  it('本机能定位到 LM Studio 时返回存在的路径', () => {
    const located = locateLmStudio({});
    if (located === null) return;
    expect(fs.existsSync(located.path)).toBe(true);
    expect(['lms-cli', 'desktop']).toContain(located.kind);
  });
});

describe('winProcess 查询', () => {
  it('未监听的端口返回 null', async () => {
    await expect(findPidListeningOnPort(65530)).resolves.toBeNull();
  });

  it('监听端口能找到本进程 PID，且不会被误判为 LM Studio', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => res.end('ok'));
    await listenOnSafePort(
      (candidate) =>
        new Promise<void>((resolveListen, rejectListen) => {
          server.once('error', rejectListen);
          server.listen(candidate, '127.0.0.1', () => resolveListen());
        }),
    );
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const pid = await findPidListeningOnPort(port);
      // 某些受限环境会拦截 netstat：允许 null，但一旦有结果必须是本进程。
      if (pid !== null) {
        expect(pid).toBe(process.pid);
        await expect(isLmStudioProcess(pid)).resolves.toBe(false);
      }
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    }
  });
});

describe('§6.3 确保模型就绪循环（ensureModelReady）', () => {
  it('目标模型已驻留 → 立即成功，绝不重复 load', async () => {
    const adapter = createFakeAdapter({
      reachable: true,
      models: [{ id: MODEL, state: 'loaded' }],
    });
    const manager = new LMStudioProcessManager(
      managerOptions({ adapter: adapter as unknown as ManagerOptions['adapter'] }),
    );
    const state = await manager.ensureModelReady(MODEL);
    expect(state.state).toBe('loaded');
    expect(adapter.loadCalls).toEqual([]);
    expect(manager.getModelLoadState()).toMatchObject({ state: 'loaded', attempts: 1 });
  });

  it('not-loaded → load 一次 → 成功', async () => {
    const adapter = createFakeAdapter({
      reachable: true,
      models: [{ id: MODEL, state: 'not-loaded' }],
    });
    const manager = new LMStudioProcessManager(
      managerOptions({ adapter: adapter as unknown as ManagerOptions['adapter'] }),
    );
    const state = await manager.ensureModelReady(MODEL);
    expect(state.state).toBe('loaded');
    // fake 的 loadMaterial 成功后把模型记为 loaded，因此一轮即成功。
    expect(adapter.loadCalls).toEqual([MODEL]);
  });

  it('load 失败 → 耗尽全部重试次数 → failed 且报告最后一次原因', async () => {
    const adapter = createFakeAdapter({
      reachable: true,
      models: [{ id: MODEL, state: 'not-loaded' }],
      // 载荷失败：每次 load 都返回 false，模型始终不 loaded。
      loadResult: false,
    });
    const manager = new LMStudioProcessManager(
      managerOptions({ adapter: adapter as unknown as ManagerOptions['adapter'], retryIntervalMs: 0 }),
    );
    const state = await manager.ensureModelReady(MODEL);
    expect(state.state).toBe('failed');
    expect(state.attempts).toBe(3);
    expect(state.maxAttempts).toBe(3);
    expect(state.lastError).toBeTruthy();
  });

  it('服务器不可达 → 每轮失败，重试到耗尽给出 failed', async () => {
    const adapter = createFakeAdapter({ reachable: false });
    const manager = new LMStudioProcessManager(
      managerOptions({
        adapter: adapter as unknown as ManagerOptions['adapter'],
        retryIntervalMs: 0,
        locate: () => null,
      }),
    );
    const state = await manager.ensureModelReady(MODEL);
    expect(state.state).toBe('failed');
    expect(state.attempts).toBe(3);
    expect(state.lastError).toContain('服务器不可达');
  });
});
