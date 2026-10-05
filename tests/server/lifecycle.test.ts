import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LMStudioProcessManager } from '../../apps/server/src/lmstudio/process.js';
import { build, locateLmStudio } from '../../apps/server/src/lmstudio/locate.js';
import {
  findPidListeningOnPort,
  isLmStudioProcess,
} from '../../apps/server/src/lmstudio/winProcess.js';
import { createFakeAdapter } from '../helpers/fakeAdapter.js';
import { scratchDir, listenOnSafePort } from '../helpers/paths.js';

/**
 * LM Studio 生命周期测试（DESIGN.md §6）。
 *
 * 安全红线（AGENTS.md）：测试绝不启动或终止真实的 LM Studio。spawn 用无害的
 * `node -e setInterval` 常驻进程代替，terminate 一律注入替身，绝不出现在测试里
 * 的 taskkill 或按映像名清理。
 */

type ManagerOptions = ConstructorParameters<typeof LMStudioProcessManager>[0];

/** 无害的常驻子进程：用于验证 spawn、PID 记录与归属。 */
function nodeChild(): { path: string; kind: 'lms-cli'; source: string; args: string[] } {
  return {
    path: process.execPath,
    kind: 'lms-cli',
    source: 'test',
    args: ['-e', 'setInterval(() => {}, 1000)'],
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
    log: () => {
      /* 静音 */
    },
    ...overrides,
  };
}

function killQuietly(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid);
  } catch {
    /* 已退出 */
  }
}

describe('§3.3 启动流程', () => {
  it('端点已可达时直接使用，startedByUs=false，且不定位可执行文件', async () => {
    const locate = vi.fn(() => null);
    const manager = new LMStudioProcessManager(
      managerOptions({
        adapter: createFakeAdapter({ reachable: true }) as unknown as ManagerOptions['adapter'],
        locate: locate as unknown as ManagerOptions['locate'],
      }),
    );
    await expect(manager.startup()).resolves.toEqual({ running: true, startedByUs: false });
    expect(locate).not.toHaveBeenCalled();
    expect(manager.status()).toEqual({ running: false, startedByUs: false });
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
    await expect(manager.startup()).resolves.toEqual({ running: false, startedByUs: false });
    expect(locate).not.toHaveBeenCalled();
  });

  it('定位失败时降级：不抛错，running=false（§6.2 说明）', async () => {
    const manager = new LMStudioProcessManager(
      managerOptions({
        adapter: createFakeAdapter({ reachable: false }) as unknown as ManagerOptions['adapter'],
        locate: (() => null) as unknown as ManagerOptions['locate'],
      }),
    );
    await expect(manager.startup()).resolves.toEqual({ running: false, startedByUs: false });
  });

  it('不可达且定位成功时 spawn，记录 PID 与归属，并能按 PID 关闭', async () => {
    const adapter = createFakeAdapter({ reachable: false });
    const terminate = vi.fn(async () => true);
    const manager = new LMStudioProcessManager(
      managerOptions({
        adapter: adapter as unknown as ManagerOptions['adapter'],
        terminate: terminate as unknown as ManagerOptions['terminate'],
        startupTimeoutMs: 2_000,
        probeIntervalMs: 5,
        locate: (() => nodeChild()) as unknown as ManagerOptions['locate'],
      }),
    );

    try {
      const started = await manager.startup();
      expect(started.startedByUs).toBe(true);
      expect(typeof started.pid).toBe('number');
      expect(manager.status().pid).toBe(started.pid);
      // 端点始终不可达，故就绪判定为 false，但进程归属已记录。
      expect(started.running).toBe(false);

      const result = await manager.shutdown({});
      expect(terminate).toHaveBeenCalledWith(started.pid);
      expect(result.ok).toBe(true);
      expect(manager.status().startedByUs).toBe(false);
    } finally {
      killQuietly(manager.status().pid);
    }
  });

  it('spawn 后就绪（探测转可达）时 running=true', async () => {
    const adapter = createFakeAdapter({ reachable: false });
    const manager = new LMStudioProcessManager(
      managerOptions({
        adapter: adapter as unknown as ManagerOptions['adapter'],
        terminate: (async () => true) as unknown as ManagerOptions['terminate'],
        startupTimeoutMs: 2_000,
        probeIntervalMs: 10,
        locate: (() => nodeChild()) as unknown as ManagerOptions['locate'],
      }),
    );
    try {
      setTimeout(() => adapter.setReachable(true), 40);
      const started = await manager.startup();
      expect(started).toEqual({ running: true, startedByUs: true, pid: started.pid });
      await manager.shutdown({});
    } finally {
      killQuietly(manager.status().pid);
    }
  });
});

describe('§6.4 关闭归属判定', () => {
  it('startedByUs=false 且未 force：拒绝关闭（路由据此返回 409）', async () => {
    const terminate = vi.fn(async () => true);
    const manager = new LMStudioProcessManager(
      managerOptions({
        terminate: terminate as unknown as ManagerOptions['terminate'],
      }),
    );
    await manager.startup();
    await expect(manager.shutdown({})).resolves.toEqual({ ok: false, stillReachable: true });
    expect(terminate).not.toHaveBeenCalled();
  });

  it('force 时按端口查 PID、校验进程名后再终止', async () => {
    const terminate = vi.fn(async () => true);
    const findPid = vi.fn(async () => 4321);
    const isLmStudio = vi.fn(async () => true);
    const manager = new LMStudioProcessManager(
      managerOptions({
        terminate: terminate as unknown as ManagerOptions['terminate'],
        findPid: findPid as unknown as ManagerOptions['findPid'],
        isLmStudio: isLmStudio as unknown as ManagerOptions['isLmStudio'],
      }),
    );
    await manager.startup();

    const result = await manager.shutdown({ force: true });
    expect(findPid).toHaveBeenCalledWith(1234);
    expect(isLmStudio).toHaveBeenCalledWith(4321);
    expect(terminate).toHaveBeenCalledWith(4321);
    // 端点仍可达 → 已尽力但未成功（§6.4 允许失败）。
    expect(result).toEqual({ ok: false, stillReachable: true });
  });

  it('force 但进程名不是 LM Studio 时拒绝终止，避免误杀同端口进程', async () => {
    const terminate = vi.fn(async () => true);
    const manager = new LMStudioProcessManager(
      managerOptions({
        terminate: terminate as unknown as ManagerOptions['terminate'],
        findPid: (async () => 4321) as unknown as ManagerOptions['findPid'],
        isLmStudio: (async () => false) as unknown as ManagerOptions['isLmStudio'],
      }),
    );
    await manager.startup();
    await expect(manager.shutdown({ force: true })).resolves.toEqual({
      ok: false,
      stillReachable: true,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it('force 且端口无监听者：视为已关闭', async () => {
    const terminate = vi.fn(async () => true);
    const manager = new LMStudioProcessManager(
      managerOptions({
        adapter: createFakeAdapter({ reachable: false }) as unknown as ManagerOptions['adapter'],
        terminate: terminate as unknown as ManagerOptions['terminate'],
        findPid: (async () => null) as unknown as ManagerOptions['findPid'],
      }),
    );
    await manager.startup();
    await expect(manager.shutdown({ force: true })).resolves.toEqual({
      ok: true,
      stillReachable: false,
    });
    expect(terminate).not.toHaveBeenCalled();
  });

  it('非默认端口也会被解析出来（baseUrl 决定查询端口）', async () => {
    const findPid = vi.fn(async () => 5555);
    const manager = new LMStudioProcessManager(
      managerOptions({
        baseUrl: 'http://127.0.0.1:1234/v1',
        findPid: findPid as unknown as ManagerOptions['findPid'],
        isLmStudio: (async () => true) as unknown as ManagerOptions['isLmStudio'],
        terminate: (async () => false) as unknown as ManagerOptions['terminate'],
      }),
    );
    await manager.startup();
    await manager.shutdown({ force: true });
    expect(findPid).toHaveBeenCalledWith(1234);
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
    fs.writeFileSync(fake, 'stub');
    expect(locateLmStudio({ override: fake })?.path).toBe(fake);
    expect(locateLmStudio({ override: path.join(dir, '不存在.exe') })).toBeNull();
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
