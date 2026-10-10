import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { config } from '../../apps/server/src/config.js';
import { openDb, type Db } from '../../apps/server/src/db/index.js';
import { CollectionService } from '../../apps/server/src/services/collectionService.js';
import { TranslationService } from '../../apps/server/src/services/translationService.js';
import { LMStudioAdapter } from '../../apps/server/src/lmstudio/adapter.js';
import { LMStudioProcessManager } from '../../apps/server/src/lmstudio/process.js';
import { ShutdownController } from '../../apps/server/src/shutdown.js';
import { ServiceHealth } from '../../apps/server/src/health.js';
import { createApp } from '../../apps/server/src/http/app.js';
import { scratchDir, listenOnSafePort, removeDbFiles } from './paths.js';

/**
 * 测试装配：在随机端口上起一个完整后端，推理端点指向 Mock。
 *
 * 不使用 config 单例的 port / baseUrl（进程级、import 时求值），而是显式注入，
 * 使同一进程内可以起多个上下文且互不影响。
 */

export interface TestContext {
  server: Server;
  port: number;
  baseUrl: string;
  db: Db;
  dbPath: string;
  collections: CollectionService;
  translations: TranslationService;
  processManager: LMStudioProcessManager;
  shutdown: ShutdownController;
  /** 记录服务关闭请求是否发生过（默认的 exit 回调被替换为记账）。 */
  exitCalls: number[];
  close: () => Promise<void>;
}

export interface ContextOptions {
  /** Mock 的 base url；测试必须显式传入。 */
  lmStudioBaseUrl: string;
  probeTimeoutMs?: number;
  maxChars?: number;
  /** 默认 true：与 Mock 联调时使用确定性方向头（DESIGN.md §8.2）。 */
  mockHeaders?: boolean;
  /** 默认 false：测试绝不启动真实 LM Studio 进程。 */
  autoStart?: boolean;
  maxConcurrentStreams?: number;
  exeOverride?: string;
  /**
   * 模拟 `lms ps` 报告的驻留实例（§6.4）。测试**绝不**真的执行 `lms`：
   * 这里用一个内存列表回答 `lms ps --json`，并把 `lms unload <id>` 落实为
   * 从列表中移除，从而能断言"卸载后确实不再驻留"。
   */
  loadedInstances?: string[];
  /** 卸载目标（§11 `LMSTUDIO_MODEL`）。默认与 config 一致。 */
  modelId?: string;
  /** 让 `lms` 调用失败（模拟找不到 CLI / 超时），用于降级路径断言。 */
  lmsFailure?: 'timeout' | 'spawn-error';
  /** 模拟"定位不到 lms CLI"：unload() 应降级为什么都不做（§6.4）。 */
  lmsMissing?: boolean;
  /** 记录实际发起过的 `lms` 调用，便于断言参数（`-p` / `--bind` 等）。 */
  lmsCalls?: string[][];
  /** 服务健康状态机；缺省新建一个（只会在 `/api/service/status` 被访问时用到）。 */
  health?: ServiceHealth;
  /** 模型加载重试次数（§6.3 确保就绪循环）。 */
  retryAttempts?: number;
  /** 单次加载后等待 state 变 loaded 的超时（测试里缩短以便快速断言）。 */
  loadWaitTimeoutMs?: number;
}

let counter = 0;

export async function createTestContext(options: ContextOptions): Promise<TestContext> {
  const scratch = scratchDir('server');
  const dbPath = path.join(scratch, `translations-${process.pid}-${counter++}.db`);
  const db = openDb(dbPath);
  const collections = new CollectionService(db);
  collections.init();

  const adapter = new LMStudioAdapter({
    baseUrl: options.lmStudioBaseUrl,
    probeTimeoutMs: options.probeTimeoutMs ?? 1_000,
  });
  const translations = new TranslationService(adapter, collections, {
    maxChars: options.maxChars ?? config.translateMaxChars,
    mockHeaders: options.mockHeaders ?? true,
  });
  const loaded: string[] = [...(options.loadedInstances ?? [])];
  const processManager = new LMStudioProcessManager({
    adapter,
    baseUrl: options.lmStudioBaseUrl,
    startupTimeoutMs: 0,
    probeIntervalMs: 1,
    showConsole: false,
    autoStart: options.autoStart ?? false,
    exeOverride: options.exeOverride ?? '',
    startArgs: [],
    modelId: options.modelId ?? config.lmstudioModel,
    unloadTimeoutMs: 1_000,
    listTimeoutMs: 1_000,
    retryAttempts: options.retryAttempts ?? config.lmstudioRetryAttempts,
    retryIntervalMs: 1,
    loadWaitTimeoutMs: options.loadWaitTimeoutMs ?? 500,
    // 默认提供一个"可定位"的 lms CLI：`lms` 由下面的内存替身应答，
    // 因此这里只是让 unload() 能走到卸载分支。设为 true 可测试"找不到 CLI"的降级。
    locate: options.lmsMissing === true
      ? () => null
      : () => ({ path: 'lms.exe', kind: 'lms-cli' as const, source: 'test', args: ['server', 'start'] }),
    // `lms` 全程由内存替身应答（AGENTS.md：测试绝不触碰真实 LM Studio）。
    runLms: async (_exe, args) => {
      options.lmsCalls?.push(args);
      if (options.lmsFailure === 'timeout') {
        return { ok: false, code: null, stdout: '', stderr: '', timedOut: true };
      }
      if (options.lmsFailure === 'spawn-error') {
        return { ok: false, code: 1, stdout: '', stderr: 'lms not found', timedOut: false };
      }
      if (args[0] === 'ps') {
        return {
          ok: true,
          code: 0,
          stdout: JSON.stringify(loaded.map((id) => ({ identifier: id }))),
          stderr: '',
          timedOut: false,
        };
      }
      if (args[0] === 'unload' && args[1] !== undefined) {
        // 实测：无论成功与否 `lms unload` 都返回 0；模型不存在时打印 Model Not Found。
        const index = loaded.indexOf(args[1]);
        if (index >= 0) loaded.splice(index, 1);
        return {
          ok: true,
          code: 0,
          stdout: index >= 0 ? `Model "${args[1]}" unloaded.` : 'Model Not Found',
          stderr: '',
          timedOut: false,
        };
      }
      return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false };
    },
  });

  const exitCalls: number[] = [];
  const shutdown = new ShutdownController({
    processManager,
    closeResources: () => {
      if (db.open) db.close();
    },
    exit: (code) => {
      exitCalls.push(code);
    },
    log: () => {
      /* 静音 */
    },
    gracePeriodMs: 0,
  });

  const app = createApp({
    collections,
    translations,
    adapter,
    processManager,
    shutdown,
    health: options.health ?? new ServiceHealth(),
    webRoot: path.join(scratch, 'no-web-root'),
    maxConcurrentStreams: options.maxConcurrentStreams ?? config.maxConcurrentStreams,
  });

  // 显式挑一个安全端口，而不是 listen(0)：临时端口可能落在 Node fetch 的拒绝列表里
  // （bad port），造成随机失败。见 listenOnSafePort 的说明。
  let bound: Server | null = null;
  await listenOnSafePort(
    (candidate) =>
      new Promise<void>((resolveListen, rejectListen) => {
        const instance = app.listen(candidate, '127.0.0.1', () => {
          bound = instance;
          resolveListen();
        });
        instance.once('error', rejectListen);
      }),
  );
  const server = bound as Server | null;
  if (server === null) throw new Error('测试后端未能启动');
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    db,
    dbPath,
    collections,
    translations,
    processManager,
    shutdown,
    exitCalls,
    close: async () => {
      // §6.4：停机不再终止任何进程，因此这里无需按 PID 收尾——
      // 这正是新设计消除的那类风险（旧实现在这里对常驻子进程 process.kill）。
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      if (db.open) db.close();
      removeDbFiles(dbPath);
    },
  };
}
