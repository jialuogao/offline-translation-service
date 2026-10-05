import { spawn, type ChildProcess } from 'node:child_process';
import type { LmStudioStatus } from '@ots/contracts';
import type { LMStudioAdapter, ModelInfo } from './adapter.js';
import { isModelResident } from './adapter.js';
import { build, locateLmStudio, type LocatedExecutable } from './locate.js';
import { instancesOf, parseLoadedIdentifiers, runLms, type LmsResult } from './lmsCli.js';

/**
 * LM Studio 生命周期（DESIGN.md §3.4 / §6）。
 *
 * 只在启动与关闭时介入，推理期不参与。
 *
 * **关闭方向已于 2026-10-05 重新决定（§6.4）**：本管理器**永不终止 LM Studio
 * 进程**，也不执行 `lms server stop`。关闭时唯一做的事是卸载 `LMSTUDIO_MODEL`
 * 指向的模型（含其全部实例），本地服务器保持运行。无法可靠卸载时按"完全不碰"
 * 降级——不尝试任何进程终止手段。
 */

export interface LMStudioProcessManagerOptions {
  adapter: LMStudioAdapter;
  baseUrl: string;
  startupTimeoutMs: number;
  probeIntervalMs: number;
  showConsole: boolean;
  autoStart: boolean;
  /** `LMSTUDIO_EXE` 覆盖值。 */
  exeOverride: string;
  /** `LMSTUDIO_START_ARGS` 覆盖值。 */
  startArgs: string[];
  /** 卸载目标（§11 `LMSTUDIO_MODEL`）。 */
  modelId: string;
  /** `lms unload` 子进程超时。 */
  unloadTimeoutMs: number;
  /** `lms ps --json` 子进程超时。 */
  listTimeoutMs: number;
  /** 注入点：默认 `locateLmStudio`，测试可替换。 */
  locate?: typeof locateLmStudio;
  /** 注入点：默认 `runLms`，测试可替换（测试绝不可真跑 `lms`）。 */
  runLms?: typeof runLms;
  /** 注入点：默认 `setTimeout`，测试可加速。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
}

export interface StartupResult {
  running: boolean;
  model?: string;
}

export interface UnloadResult {
  /** 目标模型已不再驻留时为 true。 */
  ok: boolean;
  /** 实际执行过卸载的实例标识。 */
  unloaded: string[];
  /** 复核后仍在驻留的目标实例；非空即表示内存没有真正释放。 */
  residual: string[];
  /** 降级原因（中文，面向日志与界面）；`ok` 为 true 时不存在。 */
  reason?: string;
}

export class LMStudioProcessManager {
  private readonly options: LMStudioProcessManagerOptions;
  private child: ChildProcess | null = null;

  constructor(options: LMStudioProcessManagerOptions) {
    this.options = options;
  }

  /**
   * 启动流程（DESIGN.md §3.3 步骤 2）：
   * 1. 探测端点；可达则直接使用。
   * 2. 不可达则定位 `lms` CLI 并 spawn，轮询直到就绪或超时。
   *
   * 冷启动是有效的：桌面应用未运行时，`lms server start` 会拉起一个
   * 无界面的 `LM Studio.exe --run-as-service` 实例（实测约 3.3s）。
   */
  async startup(): Promise<StartupResult> {
    if (await this.options.adapter.isReachable()) {
      this.options.log?.('LM Studio 已在运行，直接使用');
      return { running: true };
    }

    if (!this.options.autoStart) {
      this.options.log?.('LM Studio 不可达，且已禁用自动启动（LMSTUDIO_AUTOSTART=false）');
      return { running: false };
    }

    const located = this.locate();
    if (located === null) {
      this.options.log?.('未能定位 LM Studio 可执行文件；服务继续启动，翻译将返回 LMSTUDIO_UNAVAILABLE');
      return { running: false };
    }

    // 桌面版没有 `server start` / `unload` 子命令（§6.2 实测），
    // 既不能用于启动，也不参与卸载，因此只识别不 spawn。
    if (located.kind !== 'lms-cli') {
      this.options.log?.(
        `仅定位到 LM Studio 桌面版（${located.source}），它不支持 lms 子命令；`
        + '请手动打开 LM Studio 的本地服务器后重试',
      );
      return { running: false };
    }

    return this.launch(located);
  }

  /** 定位可执行文件（也可供日志展示）。 */
  locate(): LocatedExecutable | null {
    return (this.options.locate ?? locateLmStudio)({
      override: this.options.exeOverride,
      startArgs: this.options.startArgs,
    });
  }

  private async launch(located: LocatedExecutable): Promise<StartupResult> {
    const args = serverStartArgs(this.options.baseUrl, located.args);

    this.options.log?.(
      `启动 LM Studio 服务器：${located.path} ${args.join(' ')}（来源：${located.source}）`,
    );

    const child = spawn(located.path, args, {
      windowsHide: !this.options.showConsole,
      detached: false,
      stdio: 'ignore',
    });
    this.child = child;
    // §6.3：`lms server start` 是短命 CLI（约 0.3s），这里**不记录 PID**——
    // 那个进程随即退出，PID 很快失效且可能被系统复用。
    child.on('error', (error) => {
      this.options.log?.(`LM Studio 启动失败：${error.message}`);
      this.child = null;
    });
    child.on('exit', (code, signal) => {
      this.options.log?.(
        `LM Studio 启动命令已结束（code=${code ?? 'null'} signal=${signal ?? 'null'}）；`
        + '服务器由 LM Studio 自身托管，不随该命令退出',
      );
      if (this.child === child) this.child = null;
    });
    if (typeof child.unref === 'function') child.unref();

    const running = await this.waitUntilReachable();
    if (!running) {
      this.options.log?.(
        `等待 LM Studio 就绪超时（${this.options.startupTimeoutMs}ms）；服务继续启动`,
      );
      return { running: false };
    }
    this.options.log?.('LM Studio 已就绪');
    return { running: true };
  }

  /** 轮询直到就绪或耗尽总超时；间隔前 10 次固定，之后指数退避至 3000ms（§6.1）。 */
  private async waitUntilReachable(signal?: AbortSignal): Promise<boolean> {
    const sleep = this.options.sleep ?? defaultSleep;
    const deadline = Date.now() + this.options.startupTimeoutMs;
    let interval = this.options.probeIntervalMs;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      if (await this.options.adapter.isReachable(signal)) return true;
      if (Date.now() >= deadline || signal?.aborted === true) return false;
      const remaining = deadline - Date.now();
      await sleep(Math.min(interval, Math.max(remaining, 0)), signal);
      if (attempt >= 10) interval = Math.min(interval * 2, 3000);
    }
  }

  /**
   * 卸载本项目使用的模型（DESIGN.md §6.4）。
   *
   * - 目标固定为 `LMSTUDIO_MODEL`，**连同它的全部实例**（`id`、`id:2`…）。
   * - 其它模型一律不动。
   * - `lms unload` 的退出码恒为 0（模型未驻留时打印 `Model Not Found`，退出码仍是 0），
   *   因此成败只能靠 `lms ps --json` 复核判断。
   * - 服务器与桌面应用都**保持运行**；本方法从不终止任何进程。
   */
  async unload(): Promise<UnloadResult> {
    const target = this.options.modelId.trim();
    if (target === '') {
      return { ok: false, unloaded: [], residual: [], reason: '未配置 LMSTUDIO_MODEL，无法确定卸载目标' };
    }

    const located = this.locate();
    if (located === null || located.kind !== 'lms-cli') {
      return {
        ok: false,
        unloaded: [],
        residual: [],
        reason: '未找到 lms CLI，无法卸载（不会终止任何进程，请手动卸载模型）',
      };
    }

    const before = await this.listInstances(located.path);
    if (before === null) {
      return {
        ok: false,
        unloaded: [],
        residual: [],
        reason: 'lms ps 查询失败或超时，无法确认卸载目标（不会终止任何进程）',
      };
    }

    const targets = instancesOf(before, target);
    if (targets.length === 0) {
      this.options.log?.(`模型 ${target} 当前未驻留，无需卸载`);
      return { ok: true, unloaded: [], residual: [] };
    }

    const run = this.options.runLms ?? runLms;
    const unloaded: string[] = [];
    for (const instance of targets) {
      const result = await run(located.path, ['unload', instance], this.options.unloadTimeoutMs);
      if (result.timedOut) {
        return {
          ok: false,
          unloaded,
          residual: [],
          reason: `lms unload ${instance} 超时（${this.options.unloadTimeoutMs}ms），已停止后续卸载`,
        };
      }
      if (!result.ok) {
        return {
          ok: false,
          unloaded,
          residual: [],
          reason: `lms unload ${instance} 执行失败：${summarize(result)}`,
        };
      }
      unloaded.push(instance);
      this.options.log?.(`已卸载模型实例：${instance}`);
    }

    // 复核：退出码不可信，只能靠列表确认。
    const after = await this.listInstances(located.path);
    if (after === null) {
      return {
        ok: false,
        unloaded,
        residual: [],
        reason: 'lms ps 复核失败，无法确认模型是否已卸载',
      };
    }
    const residual = instancesOf(after, target);
    if (residual.length > 0) {
      return {
        ok: false,
        unloaded,
        residual,
        reason: `复核发现仍有实例驻留：${residual.join(', ')}`,
      };
    }
    return { ok: true, unloaded, residual: [] };
  }

  /** 列出当前驻留的实例标识；失败（超时/非 JSON）返回 null。 */
  private async listInstances(exePath: string): Promise<string[] | null> {
    const run = this.options.runLms ?? runLms;
    const result = await run(exePath, ['ps', '--json'], this.options.listTimeoutMs);
    if (result.timedOut || !result.ok) return null;
    const identifiers = parseLoadedIdentifiers(result.stdout);
    // `lms ps --json` 无模型时输出 `[]`，解析结果同样是空数组，
    // 因此无法区分"没有模型"与"输出不可解析"。这里只认 `[]` 字面量，
    // 其余一律视为"无法确认"，让调用方按降级处理而不是误判为可卸载。
    if (identifiers.length === 0) {
      return result.stdout.trim() === '[]' ? [] : null;
    }
    return identifiers;
  }

  /** 供 `GET /api/lmstudio/status` 的实时探测使用。 */
  async probeStatus(): Promise<LmStudioStatus> {
    const reachable = await this.options.adapter.isReachable();
    let modelLoaded: string | undefined;
    if (reachable) {
      try {
        const models = await this.options.adapter.describeModels();
        // 优先报告真正驻留的模型（§13 第 5 条：区分已加载与仅可用）。
        modelLoaded = (models.find((model) => model.state === 'loaded') ?? models[0])?.id;
      } catch {
        modelLoaded = undefined;
      }
    }
    return {
      running: reachable,
      ...(modelLoaded !== undefined ? { modelLoaded } : {}),
    };
  }

  /**
   * 显式预热模型（DESIGN.md §13 第 5 条开放项的实现）。
   *
   * `/v1/models` 只列出磁盘上的模型，`state` 为 `not-loaded` 时首次推理会触发隐式
   * 加载，30B MoE 冷加载可能耗时数十秒。因此在端点就绪后异步调一次
   * `POST /api/v1/models/load`：成功则首条翻译立即开跑，失败也不影响服务可用性。
   *
   * **已驻留则不发请求**：LM Studio 的 load 端点每次成功调用都会新建一个实例
   * （见 `LMStudioAdapter.loadModel`），重复预热会把显存/内存耗尽。这里先看状态，
   * 命中已加载就返回 `alreadyResident: true`。
   */
  async warmup(modelId?: string): Promise<{
    attempted: boolean;
    model?: string;
    ok: boolean;
    alreadyResident: boolean;
  }> {
    let target = modelId?.trim() ?? '';
    let models: ModelInfo[] | undefined;
    try {
      models = await this.options.adapter.describeModels();
    } catch {
      models = undefined;
    }

    if (target === '') {
      target = (models?.find((model) => model.state === 'loaded') ?? models?.[0])?.id ?? '';
    }
    if (target === '') return { attempted: false, ok: false, alreadyResident: false };

    // `state: unknown`（端点只有 /v1/models）不算已驻留：宁可多加载一次，也不要漏加载。
    const stateKnown = models?.some((model) => model.state !== 'unknown') ?? false;
    const resident = stateKnown && models !== undefined && isModelResident(models, target);
    if (resident) {
      return { attempted: false, model: target, ok: true, alreadyResident: true };
    }

    const ok = await this.options.adapter.loadModel(target);
    return { attempted: true, model: target, ok, alreadyResident: false };
  }
}

/**
 * 拼出 `lms server start` 的完整参数（DESIGN.md §6.3，2026-10-05 锁定）。
 *
 * 抽出为纯函数是为了能直接断言参数，而不必去 mock ESM 的 `spawn`——
 * 后者无法被 `vi.spyOn` 重定义。
 *
 * - `-p <port>`：**必须显式传**。实测不传时 `lms server start` 会沿用上一次的
 *   端口，未必等于 `LMSTUDIO_BASE_URL` 的端口，会导致探测不到而误报"未检测到"。
 * - `--bind 127.0.0.1`：本服务无鉴权（§1.3），绝不能让推理端点暴露到局域网。
 *
 * 两者都可被调用方已显式提供的同名参数覆盖。
 */
export function serverStartArgs(baseUrl: string, locatedArgs: string[]): string[] {
  const args = [...locatedArgs];
  const port = portOf(baseUrl);
  if (port !== null && !args.includes('-p')) args.push('-p', String(port));
  if (!args.includes('--bind')) args.push('--bind', '127.0.0.1');
  return args;
}

function summarize(result: LmsResult): string {
  const text = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/)[0] ?? '';
  return text === '' ? `退出码 ${result.code ?? 'null'}` : text;
}

function portOf(baseUrl: string): number | null {
  try {
    const url = new URL(baseUrl);
    if (url.port !== '') return Number.parseInt(url.port, 10);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 由已知路径构造定位结果（供测试与诊断）。 */
export { build as buildLocatedExecutable };