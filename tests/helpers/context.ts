import fs from 'node:fs';
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
import { createApp } from '../../apps/server/src/http/app.js';
import { scratchDir, listenOnSafePort } from './paths.js';

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
  /** 注入点：按端口查 PID（测试不真的查询系统）。 */
  findPid?: () => Promise<number | null>;
  /** 注入点：进程名校验。 */
  isLmStudio?: () => Promise<boolean>;
  /** 注入点：终止进程（测试不真的 taskkill）。 */
  terminate?: (pid: number) => Promise<boolean>;
  exeOverride?: string;
  /**
   * 模拟"LM Studio 由本会话启动"：以无害的常驻 node 子进程充当被托管的实例，
   * 从而让 `startedByUs === true` 的关闭路径可测（绝不动真实 LM Studio）。
   */
  spawnOwnedProcess?: boolean;
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
  const processManager = new LMStudioProcessManager({
    adapter,
    baseUrl: options.lmStudioBaseUrl,
    startupTimeoutMs: 0,
    probeIntervalMs: 1,
    showConsole: false,
    autoStart: options.spawnOwnedProcess === true,
    exeOverride: options.exeOverride ?? '',
    startArgs: [],
    // 只有在需要模拟"本会话启动"时才允许 spawn；默认拒绝，避免误启真实进程。
    locate:
      options.spawnOwnedProcess === true
        ? () => ({
            path: process.execPath,
            kind: 'lms-cli' as const,
            source: 'test-owned-process',
            args: ['-e', 'setInterval(() => {}, 1000)'],
          })
        : () => null,
    ...(options.findPid !== undefined ? { findPid: options.findPid } : {}),
    ...(options.isLmStudio !== undefined ? { isLmStudio: options.isLmStudio } : {}),
    ...(options.terminate !== undefined ? { terminate: options.terminate } : {}),
  });

  // 需要覆盖 `startedByUs === true` 的关闭路径时，用一个无害的常驻 node 进程
  // 充当"本会话启动的 LM Studio"（AGENTS.md：测试绝不触碰真实 LM Studio）。
  // 上游是 Mock，spawn 后拿不到就绪，startup 会因 startupTimeoutMs=0 立即返回，
  // 但归属（startedByUs/pid）已经记录，这正是关闭路径要断言的状态。
  if (options.spawnOwnedProcess === true) {
    await processManager.startup();
  }

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
      // 若测试模拟了"本会话启动的 LM Studio"，收尾时按 PID 结束它。
      const owned = processManager.status();
      if (owned.startedByUs && owned.pid !== undefined) {
        await processManager.shutdown({});
        try {
          process.kill(owned.pid);
        } catch {
          /* 已退出 */
        }
      }
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      if (db.open) db.close();
      removeDbFiles(dbPath);
    },
  };
}

function removeDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${dbPath}${suffix}`;
    try {
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    } catch {
      /* scratch 清理失败不应影响断言结果 */
    }
  }
}
