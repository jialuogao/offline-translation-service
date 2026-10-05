import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Collection } from '@ots/contracts';
import { openDb, type Db } from '../../apps/server/src/db/index.js';
import { CollectionService } from '../../apps/server/src/services/collectionService.js';
import { TranslationService } from '../../apps/server/src/services/translationService.js';
import { LMStudioAdapter, LMStudioError } from '../../apps/server/src/lmstudio/adapter.js';
import { LMStudioProcessManager } from '../../apps/server/src/lmstudio/process.js';
import { ShutdownController } from '../../apps/server/src/shutdown.js';
import { createApp } from '../../apps/server/src/http/app.js';
import { api } from '../helpers/http.js';
import { listenOnSafePort, scratchDir } from '../helpers/paths.js';

/**
 * 真实 LM Studio 端到端测试的装配（DESIGN.md §13 第 5 条 / §5.3）。
 *
 * 与 `tests/helpers/context.ts` 的区别：
 * - adapter 指向**真实** LM Studio（默认 `http://127.0.0.1:1234`），不使用 Mock；
 * - 不 mock 任何东西，数据库落在 `.temp/e2e/`，不触碰 `apps/server/data/`；
 * - `autoStart=false` 且 `locate` 返回 null，因此**绝不会**启动或终止真实 LM Studio。
 *
 * 该套件只在显式执行 `pnpm test:e2e` 时运行（见 vitest.e2e.config.ts）。
 */

/** 真实端点地址，可用 `LMSTUDIO_BASE_URL` 覆盖（例如指向另一台机器）。 */
export const E2E_BASE_URL = (process.env.LMSTUDIO_BASE_URL ?? 'http://127.0.0.1:1234')
  .trim()
  .replace(/\/+$/, '');

/** 指定模型 id；留空则取端点返回的第一个模型（与生产一致，DESIGN.md §7.1）。 */
export const E2E_MODEL = (process.env.LMSTUDIO_MODEL ?? '').trim();

export interface E2EContext {
  baseUrl: string;
  port: number;
  db: Db;
  dbPath: string;
  collections: CollectionService;
  adapter: LMStudioAdapter;
  processManager: LMStudioProcessManager;
  close: () => Promise<void>;
}

/**
 * 选择用于本次 E2E 的模型 id。
 *
 * 优先用**已驻留实例的 id**（`/api/v0/models` 里 `state === 'loaded'`，可能是
 * `model:2` 这样的实例 id）：这样推理会复用已加载的实例，不会为跑一次测试再多占
 * 一份显存。注意 `/v1/models` 也会列出 `model:2`，所以对消息接口同样可用。
 */
export function chooseModelId(
  models: Array<{ id: string; state: string }>,
  chatModelIds: string[],
  override = E2E_MODEL,
): string | undefined {
  if (override !== '') return override;
  const loaded = models.find((model) => model.state === 'loaded')?.id;
  if (loaded !== undefined) return loaded;
  return chatModelIds[0];
}

/**
 * 前置条件检查：端点可达且至少有一个模型。
 * 失败时给出可操作的中文提示，而不是让测试以莫名其妙的超时收场。
 */
export async function assertRealLmStudioReady(): Promise<{
  models: Array<{ id: string; state: string }>;
  loaded: string | undefined;
}> {
  const adapter = new LMStudioAdapter({ baseUrl: E2E_BASE_URL, probeTimeoutMs: 5_000 });
  let reachable: boolean;
  try {
    reachable = await adapter.isReachable();
  } catch (error) {
    throw new Error(
      `E2E 需要真实的 LM Studio：无法访问 ${E2E_BASE_URL}（${error instanceof Error ? error.message : String(error)}）。\n` +
        '请先启动 LM Studio 并打开本地服务器（`lms server start`），或设置 LMSTUDIO_BASE_URL。',
    );
  }
  if (!reachable) {
    throw new Error(
      `E2E 需要真实的 LM Studio：${E2E_BASE_URL} 不可达。\n` +
        '请先启动 LM Studio 并打开本地服务器（`lms server start`），或设置 LMSTUDIO_BASE_URL。',
    );
  }

  let models: Array<{ id: string; state: string }>;
  try {
    models = await adapter.describeModels();
  } catch (error) {
    throw new Error(
      `E2E 无法读取模型列表（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  if (models.length === 0) {
    throw new Error(`E2E 需要至少一个模型：${E2E_BASE_URL} 返回了空列表`);
  }
  if (E2E_MODEL !== '' && !models.some((model) => model.id === E2E_MODEL)) {
    throw new Error(
      `LMSTUDIO_MODEL=${E2E_MODEL} 不在端点返回的模型列表中。可用模型：\n` +
        models.map((model) => `  - ${model.id}`).join('\n'),
    );
  }

  return { models, loaded: models.find((model) => model.state === 'loaded')?.id };
}

/** 起一个真实链路的后端（真实 adapter + 真实 SSE），数据库为 scratch。 */
export async function createE2EContext(): Promise<E2EContext> {
  const dir = scratchDir('e2e');
  const dbPath = `${dir}/translations-${Date.now()}-${Math.round(Math.random() * 1e6)}.db`;
  const db = openDb(dbPath);
  const collections = new CollectionService(db);
  collections.init();

  const adapter = new LMStudioAdapter({
    baseUrl: E2E_BASE_URL,
    probeTimeoutMs: 5_000,
    model: E2E_MODEL,
    // 30B 模型冷加载可达分钟级，这里给足时间。
    loadTimeoutMs: Number(process.env.LMSTUDIO_LOAD_TIMEOUT_MS ?? 1_800_000),
  });
  const translations = new TranslationService(adapter, collections, { mockHeaders: false });
  const processManager = new LMStudioProcessManager({
    adapter,
    baseUrl: E2E_BASE_URL,
    startupTimeoutMs: 0,
    probeIntervalMs: 1_000,
    showConsole: false,
    // 双重保险：既不允许自动启动，也定位不到可执行文件。E2E 绝不碰真实进程。
    autoStart: false,
    exeOverride: '',
    startArgs: [],
    locate: () => null,
    modelId: E2E_MODEL,
    unloadTimeoutMs: 60_000,
    listTimeoutMs: 30_000,
    log: () => {
      /* 静音 */
    },
  });

  const shutdown = new ShutdownController({
    processManager,
    closeResources: () => {
      if (db.open) db.close();
    },
    // 测试进程绝不能真的退出。
    exit: () => undefined,
    log: () => undefined,
    gracePeriodMs: 0,
  });

  const app = createApp({
    collections,
    translations,
    adapter,
    processManager,
    shutdown,
    webRoot: `${dir}/no-web-root`,
    maxConcurrentStreams: 4,
  });

  // 与常规套件一致：显式挑安全端口，避免临时端口落到 fetch 的拒绝列表里。
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
  if (server === null) throw new Error('E2E 后端未能启动');
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    db,
    dbPath,
    collections,
    adapter,
    processManager,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      if (db.open) db.close();
    },
  };
}

/** 取当前合集 id（E2E 一律用默认合集）。 */
export async function activeCollectionId(baseUrl: string): Promise<string> {
  const response = await api<{ collection: Collection }>(baseUrl, 'GET', '/api/collections/active');
  return response.body.collection.id;
}

/** 供测试打印可读的模型信息。 */
export function describeModel(id: string, state: string): string {
  return `${id}（${state}）`;
}

export { LMStudioError };
