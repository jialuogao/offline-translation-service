import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { config } from './config.js';
import { openDb } from './db/index.js';
import { CollectionService } from './services/collectionService.js';
import { TranslationService } from './services/translationService.js';
import { LMStudioAdapter } from './lmstudio/adapter.js';
import { LMStudioProcessManager } from './lmstudio/process.js';
import { ShutdownController } from './shutdown.js';
import { ServiceHealth } from './health.js';
import { createApp } from './http/app.js';

/**
 * 服务装配（DESIGN.md §3.3 启动流程）：
 * 1. 初始化 DB（建表/迁移）。
 * 2. LMStudioProcessManager.startup()：探测 → 必要时拉起。
 * 3. 启动 HTTP 服务并托管前端。
 *
 * 进程入口是 index.ts；这里不注册信号处理器，避免被测试 import 时产生副作用。
 *
 * 健康状态（§5.4 `GET /api/service/status`）：每个模块按启动顺序经历
 * `loading` → `ok` / `error`，任何中间态都会如实出现在快照里。
 */

function log(message: string): void {
  console.log(`[ots] ${message}`);
}

export interface RunningService {
  server: Server;
  shutdown: ShutdownController;
  collections: CollectionService;
  processManager: LMStudioProcessManager;
  health: ServiceHealth;
  /** 监听端口（`PORT=0` 时由系统分配，测试用）。 */
  port: number;
}

/** 组装并启动服务；返回句柄，便于测试与优雅关闭。 */
export async function startService(
  overrides: { log?: (message: string) => void; skipLmStudioStartup?: boolean } = {},
): Promise<RunningService> {
  const logger = overrides.log ?? log;
  const health = new ServiceHealth();

  logger(`数据库：${config.dbPath}`);
  health.begin('db', config.dbPath);
  fs.mkdirSync(config.dbPath.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  const db = openDb(config.dbPath);
  const collections = new CollectionService(db);
  const active = collections.init();
  health.succeed('db', config.dbPath);
  logger(`当前合集：${active.name}（${active.id}）`);

  // 数据目录可写自检：只读介质/磁盘满会让历史写不进去，但界面浏览仍可用，
  // 因此这是"记录但不致命"的模块（§5.4）。
  health.begin('storage');
  try {
    const probe = path.join(path.dirname(config.dbPath), `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    health.succeed('storage');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    health.fail('storage', message);
    logger(`警告：数据目录不可写（${message}）；翻译历史将无法保存`);
  }

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
    modelId: config.lmstudioModel,
    unloadTimeoutMs: config.lmstudioUnloadTimeoutMs,
    listTimeoutMs: config.lmstudioListTimeoutMs,
    retryAttempts: config.lmstudioRetryAttempts,
    retryIntervalMs: config.lmstudioRetryIntervalMs,
    loadWaitTimeoutMs: config.lmstudioLoadWaitTimeoutMs,
    log: (message) => logger(message),
  });

  if (overrides.skipLmStudioStartup !== true) {
    health.begin('lmstudio', '正在确保 LM Studio 服务器与模型就绪');
    const startup = await processManager.startup();
    if (startup.running) {
      logger('LM Studio 就绪');
      if (config.lmstudioWarmup) {
        // 不阻塞 HTTP 启动：30B 模型冷加载可能数十秒，先把界面放出去。
        // 这是 best-effort 循环：全部重试耗尽仍未 loaded 时服务继续运行，
        // 状态由 /api/service/status 忠实汇报（§5.4 / §6.3）。
        void processManager
          .ensureModelReady(config.lmstudioModel)
          .then(() => {
            const state = processManager.getModelLoadState();
            if (state.state === 'loaded') {
              health.succeed('lmstudio', `模型已加载：${state.model}`);
              logger(`模型已预加载：${state.model}`);
              return;
            }
            const reason = state.lastError ?? '未知原因';
            health.fail('lmstudio', reason, `模型加载失败（已尝试 ${state.attempts}/${state.maxAttempts} 次）`);
            logger(
              `模型预加载未成功（已尝试 ${state.attempts}/${state.maxAttempts} 次）：${reason}`
              + '；服务继续运行，首次翻译会尝试隐式加载，可稍后重试',
            );
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            health.fail('lmstudio', message, '模型预加载循环异常');
            logger(`模型预加载出错（已忽略）：${message}`);
          });
      } else {
        health.succeed('lmstudio', '已禁用自动加载（LMSTUDIO_WARMUP=false）');
      }
    } else {
      const reason = 'LM Studio 服务器不可用';
      health.fail('lmstudio', reason);
      logger(`${reason}；翻译将返回 LMSTUDIO_UNAVAILABLE，可稍后重试`);
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
    health,
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

  // 停机时用它停止接受新连接（§3.4）：app 必须先建好才能 listen，
  // 而停机控制器又是 app 的依赖，因此在此回填。
  shutdown.attachServer(server);

  return { server, shutdown, collections, processManager, health, port };
}
