import fs from 'node:fs';
import type { Server } from 'node:http';
import { config } from './config.js';
import { openDb } from './db/index.js';
import { CollectionService } from './services/collectionService.js';
import { TranslationService } from './services/translationService.js';
import { LMStudioAdapter } from './lmstudio/adapter.js';
import { LMStudioProcessManager } from './lmstudio/process.js';
import { ShutdownController } from './shutdown.js';
import { createApp } from './http/app.js';

/**
 * 服务装配（DESIGN.md §3.3 启动流程）：
 * 1. 初始化 DB（建表/迁移）。
 * 2. LMStudioProcessManager.startup()：探测 → 必要时拉起。
 * 3. 启动 HTTP 服务并托管前端。
 *
 * 进程入口是 index.ts；这里不注册信号处理器，避免被测试 import 时产生副作用。
 */

function log(message: string): void {
  console.log(`[ots] ${message}`);
}

export interface RunningService {
  server: Server;
  shutdown: ShutdownController;
  collections: CollectionService;
  processManager: LMStudioProcessManager;
  /** 监听端口（`PORT=0` 时由系统分配，测试用）。 */
  port: number;
}

/** 组装并启动服务；返回句柄，便于测试与优雅关闭。 */
export async function startService(
  overrides: { log?: (message: string) => void; skipLmStudioStartup?: boolean } = {},
): Promise<RunningService> {
  const logger = overrides.log ?? log;
  logger(`数据库：${config.dbPath}`);
  fs.mkdirSync(config.dbPath.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  const db = openDb(config.dbPath);
  const collections = new CollectionService(db);
  const active = collections.init();
  logger(`当前合集：${active.name}（${active.id}）`);

  const adapter = new LMStudioAdapter({
    baseUrl: config.lmstudioBaseUrl,
    probeTimeoutMs: config.lmstudioProbeTimeoutMs,
    model: config.lmstudioModel,
    loadTimeoutMs: config.lmstudioLoadTimeoutMs,
  });

  const processManager = new LMStudioProcessManager({
    adapter,
    baseUrl: config.lmstudioBaseUrl,
    startupTimeoutMs: config.lmstudioStartupTimeoutMs,
    probeIntervalMs: config.lmstudioProbeIntervalMs,
    showConsole: config.lmstudioShowConsole,
    autoStart: config.lmstudioAutoStart,
    exeOverride: config.lmstudioExe,
    startArgs: config.lmstudioStartArgs,
    log: (message) => logger(message),
  });

  if (overrides.skipLmStudioStartup !== true) {
    const startup = await processManager.startup();
    if (startup.running) {
      logger(
        `LM Studio 就绪（startedByUs=${startup.startedByUs}${startup.pid === undefined ? '' : `, pid=${startup.pid}`}）`,
      );
      if (config.lmstudioWarmup) {
        // 不阻塞 HTTP 启动：30B 模型冷加载可能数十秒，先把界面放出去。
        void processManager
          .warmup(config.lmstudioModel)
          .then((result) => {
            if (result.alreadyResident) {
              // 已驻留就不要再 load：LM Studio 每次成功 load 都会新建实例（吃内存）。
              logger(`模型已驻留内存，跳过预加载：${result.model}`);
              return;
            }
            if (!result.attempted) return;
            logger(
              result.ok
                ? `模型已预加载：${result.model}`
                : `模型预加载未成功（${result.model}），首次翻译可能较慢`,
            );
          })
          .catch((error: unknown) => {
            logger(
              `模型预加载出错（已忽略）：${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
    } else {
      logger('LM Studio 不可用；翻译将返回 LMSTUDIO_UNAVAILABLE，可稍后重试');
    }
  }

  const translations = new TranslationService(adapter, collections, {
    maxChars: config.translateMaxChars,
    mockHeaders: config.mockHeaders,
  });

  const shutdown = new ShutdownController({
    processManager,
    closeResources: () => db.close(),
    log: (message) => logger(message),
  });

  const app = createApp({
    collections,
    translations,
    adapter,
    processManager,
    shutdown,
    webRoot: config.webRoot,
    maxConcurrentStreams: config.maxConcurrentStreams,
  });

  const server = await new Promise<Server>((resolve, reject) => {
    // 只监听回环地址：本服务无鉴权，不得暴露到局域网（AGENTS.md 实现约定 8）。
    const instance = app.listen(config.port, config.host, () => resolve(instance));
    instance.on('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  logger(`HTTP 服务已启动：http://${config.host}:${port}`);

  return { server, shutdown, collections, processManager, port };
}
