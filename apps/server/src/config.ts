import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 运行时配置（DESIGN.md §11）。所有值只在此处读取环境变量，其它模块引用 `config`，
 * 避免环境变量散落在业务代码中。
 */

/** `apps/server` 目录绝对路径（编译后为 `dist/` 的上一级）。 */
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function int(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`环境变量 ${name} 非法：${raw}（应为 ≥ ${min} 的整数）`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** 默认数据库位置：`apps/server/data/translations.db`（随 NODE_ENV=test 走 .temp/）。 */
function defaultDbPath(): string {
  const repoRoot = path.resolve(appRoot, '..', '..');
  if (process.env.NODE_ENV === 'test') {
    return path.join(repoRoot, '.temp', 'server-default', 'translations.db');
  }
  return path.join(appRoot, 'data', 'translations.db');
}

export const config = {
  /** 后端 HTTP 端口，DESIGN.md §11：默认 5174（避开 Vite 5173）。 */
  port: int('PORT', 5174, 1),
  /** 仅监听回环地址：本服务按设计无鉴权（§1.3），不得暴露到局域网。 */
  host: str('HOST', '127.0.0.1'),

  /** SQLite 单文件路径。 */
  dbPath: path.resolve(str('DB_PATH', defaultDbPath())),

  /** 推理端点；测试时指向 tests/mock-lmstudio。 */
  lmstudioBaseUrl: str('LMSTUDIO_BASE_URL', 'http://127.0.0.1:1234').replace(/\/+$/, ''),
  /** 覆盖 lmstudio.exe 路径（§6.2 优先级 1）。 */
  lmstudioExe: str('LMSTUDIO_EXE', ''),
  /** 指定 model id；空则取 `/v1/models` 首个（§7.1）。 */
  lmstudioModel: str('LMSTUDIO_MODEL', ''),
  /**
   * 启动探测总超时（§6.1）。实测结论（§13 第 5 条）：`/v1/models` 只表示服务器
   * 就绪，模型冷加载发生在首次推理，故默认从设计稿的 60s 调整为 120s 以便
   * `lmstudio.exe` 冷启动（服务器进程拉起 + 端口监听）更稳。
   */
  lmstudioStartupTimeoutMs: int('LMSTUDIO_STARTUP_TIMEOUT_MS', 120_000, 0),
  /** 探测初始间隔；超过 10 次后指数退避至 3000ms（§6.1）。 */
  lmstudioProbeIntervalMs: int('LMSTUDIO_PROBE_INTERVAL_MS', 1_000, 1),
  /** 单次探测/请求超时（§6.1：单次 2s）。 */
  lmstudioProbeTimeoutMs: int('LMSTUDIO_PROBE_TIMEOUT_MS', 2_000, 1),
  /** 端点就绪后是否显式加载模型，避免首条翻译触发隐式加载而超时（§13 第 5 条）。 */
  lmstudioWarmup: bool('LMSTUDIO_WARMUP', true),
  /** 显式加载模型允许的耗时（30B MoE 冷加载可能超过 60s）。 */
  lmstudioLoadTimeoutMs: int('LMSTUDIO_LOAD_TIMEOUT_MS', 300_000, 1_000),
  /** spawn lmstudio.exe 时是否显示 console 窗口（调试用，默认隐藏）。 */
  lmstudioShowConsole: bool('LMSTUDIO_SHOW_CONSOLE', false),
  /** 是否允许后端自动 spawn LM Studio（测试注入未就绪场景时置 false）。 */
  lmstudioAutoStart: bool('LMSTUDIO_AUTOSTART', true),
  /** spawn lmstudio.exe 时使用的参数（实测校准，见 docs/impl-notes/lmstudio-lifecycle.md）。 */
  lmstudioStartArgs: str('LMSTUDIO_START_ARGS', 'server start')
    .split(/\s+/)
    .filter((part) => part.length > 0),

  /** 单次翻译原文最大字符数（§5.3）。 */
  translateMaxChars: int('TRANSLATE_MAX_CHARS', 10_000, 1),

  /** SSE 并发上限（§9.4 建议 ≤ 4）。 */
  maxConcurrentStreams: int('MAX_CONCURRENT_STREAMS', 4, 1),

  /**
   * 测试专用：向 adapter 请求附加 `X-Mock-Source-Lang` 等头，使 Mock 的方向判定
   * 确定（DESIGN.md §8.2）。默认关闭，生产流量不会带出这些头。
   */
  mockHeaders: bool('LMSTUDIO_MOCK_HEADERS', false),

  /** 前端构建产物目录（`vite build` 输出到 apps/server/public）。 */
  webRoot: path.join(appRoot, 'public'),

  isTest: process.env.NODE_ENV === 'test',
} as const;

export type Config = typeof config;
