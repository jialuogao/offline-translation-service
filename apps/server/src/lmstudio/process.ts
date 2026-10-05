import { spawn, type ChildProcess } from 'node:child_process';
import type { LmStudioStatus } from '@ots/contracts';
import type { LMStudioAdapter, ModelInfo } from './adapter.js';
import { isModelResident } from './adapter.js';
import { build, locateLmStudio, type LocatedExecutable } from './locate.js';
import { findPidListeningOnPort, isLmStudioProcess, terminateProcessTree } from './winProcess.js';

/**
 * LM Studio 进程生命周期（DESIGN.md §3.4 / §6）。
 *
 * 只在启动与关闭时介入，推理期不参与。归属判定是硬约束（§6.4）：
 * 只有本会话自己 spawn 的实例才会被自动终止；外部实例必须由用户显式确认。
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
  /** 注入点：默认 `locateLmStudio`，测试可替换。 */
  locate?: typeof locateLmStudio;
  /** 注入点：默认按端口查 PID，测试可替换。 */
  findPid?: typeof findPidListeningOnPort;
  /** 注入点：默认校验进程名，测试可替换。 */
  isLmStudio?: typeof isLmStudioProcess;
  /** 注入点：默认按 PID 终止进程树。 */
  terminate?: typeof terminateProcessTree;
  /** 注入点：默认 `setTimeout`，测试可加速。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
}

export interface StartupResult {
  running: boolean;
  startedByUs: boolean;
  pid?: number;
  model?: string;
}

export interface ShutdownResult {
  ok: boolean;
  /** 目标端点仍可达时为 true（尽力而为但未成功）。 */
  stillReachable: boolean;
}

export class LMStudioProcessManager {
  private readonly options: LMStudioProcessManagerOptions;
  private child: ChildProcess | null = null;
  private startedByUs = false;
  private stoppedByUs = false;
  private warnedExit = false;

  constructor(options: LMStudioProcessManagerOptions) {
    this.options = options;
  }

  /**
   * 启动流程（DESIGN.md §3.3 步骤 2）：
   * 1. 探测端点；可达则 `startedByUs = false` 直接使用。
   * 2. 不可达则定位可执行文件并 spawn，轮询直到就绪或超时。
   * 3. 记录归属与 PID，供关闭时决策。
   */
  async startup(): Promise<StartupResult> {
    if (await this.options.adapter.isReachable()) {
      this.options.log?.('LM Studio 已在运行，直接使用（startedByUs=false）');
      return { running: true, startedByUs: false };
    }

    if (!this.options.autoStart) {
      this.options.log?.('LM Studio 不可达，且已禁用自动启动（LMSTUDIO_AUTOSTART=false）');
      return { running: false, startedByUs: false };
    }

    const located = this.locate();
    if (located === null) {
      this.options.log?.('未能定位 LM Studio 可执行文件；服务继续启动，翻译将返回 LMSTUDIO_UNAVAILABLE');
      return { running: false, startedByUs: false };
    }

    return this.launch(located);
  }

  /** 定位可执行文件（也可供前端/日志展示）。 */
  locate(): LocatedExecutable | null {
    return (this.options.locate ?? locateLmStudio)({
      override: this.options.exeOverride,
      startArgs: this.options.startArgs,
    });
  }

  private async launch(located: LocatedExecutable): Promise<StartupResult> {
    this.options.log?.(
      `启动 LM Studio：${located.path} ${located.args.join(' ')}（来源：${located.source}）`,
    );
    this.stoppedByUs = false;
    this.warnedExit = false;

    const child = spawn(located.path, located.args, {
      windowsHide: !this.options.showConsole,
      detached: false,
      stdio: 'ignore',
    });
    this.child = child;
    this.startedByUs = true;
    const pid = child.pid;
    child.on('error', (error) => {
      this.options.log?.(`LM Studio 启动失败：${error.message}`);
      this.child = null;
      this.startedByUs = false;
    });
    // §6.3：运行期被外部关闭时标记 running=false，允许后续重试启动。
    child.on('exit', (code, signal) => {
      if (!this.warnedExit && !this.stoppedByUs) {
        this.options.log?.(
          `LM Studio 进程已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）；后续可重试启动`,
        );
        this.warnedExit = true;
      }
      if (this.child === child) {
        this.child = null;
        this.startedByUs = false;
      }
    });
    if (typeof child.unref === 'function') child.unref();

    const running = await this.waitUntilReachable();
    if (!running) {
      this.options.log?.(
        `等待 LM Studio 就绪超时（${this.options.startupTimeoutMs}ms）；服务继续启动`,
      );
      return { running: false, startedByUs: true, pid };
    }
    this.options.log?.('LM Studio 已就绪');
    return { running: true, startedByUs: true, pid };
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

  /** 不产生活动：仅报告当前认知（§5.4 `GET /api/lmstudio/status`）。 */
  status(): { running: boolean; startedByUs: boolean; pid?: number } {
    const running = this.child !== null && this.child.exitCode === null;
    return {
      running,
      startedByUs: this.startedByUs,
      ...(this.child?.pid !== undefined ? { pid: this.child.pid } : {}),
    };
  }

  /** 供 `GET /api/lmstudio/status` 的实时探测使用。 */
  async probeStatus(): Promise<LmStudioStatus> {
    const reachable = await this.options.adapter.isReachable();
    const base = this.status();
    let modelLoaded: string | undefined;
    if (reachable) {
      try {
        const models = await this.options.adapter.describeModels();
        // 优先报告真正驻留内存的模型（§13 第 5 条：区分已加载与仅可用）。
        modelLoaded = (models.find((model) => model.state === 'loaded') ?? models[0])?.id;
      } catch {
        modelLoaded = undefined;
      }
    }
    return {
      running: reachable,
      // 归属只由本会话是否 spawn 决定，与当前可达性无关（§6.4）。
      startedByUs: base.startedByUs,
      ...(modelLoaded !== undefined ? { modelLoaded } : {}),
      ...(base.pid !== undefined ? { pid: base.pid } : {}),
    };
  }

  /**
   * 显式预热模型（§13 第 5 条开放项的实现）。
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

  /**
   * 关闭 LM Studio（DESIGN.md §5.4 / §6.4）。
   *
   * - `startedByUs === true`：按记录的子进程 PID 终止，`force` 无意义。
   * - `startedByUs === false`：只有 `force === true` 才尝试终止；先按端口查 PID，
   *   校验进程名确为 LM Studio 才动手，失败静默（已尽力）。
   * - 非本会话启动且未 force：`{ ok: false }`，路由据此返回 409。
   */
  async shutdown(opts: { force?: boolean } = {}): Promise<ShutdownResult> {
    if (this.startedByUs && this.child?.pid !== undefined) {
      const pid = this.child.pid;
      const killed = await this.terminate(pid, { requireLmStudioName: false });
      if (killed) {
        this.stoppedByUs = true;
        this.child = null;
        this.startedByUs = false;
      }
      return this.resultOf(killed);
    }

    if (opts.force !== true) {
      return { ok: false, stillReachable: true };
    }

    const port = portOf(this.options.baseUrl);
    if (port === null) return { ok: false, stillReachable: true };

    const findPid = this.options.findPid ?? findPidListeningOnPort;
    const pid = await findPid(port);
    if (pid === null) {
      // 端口已无监听者：目标已经不在运行。
      return this.resultOf(true);
    }

    const verify = this.options.isLmStudio ?? isLmStudioProcess;
    if (!(await verify(pid))) {
      this.options.log?.(`端口 ${port} 被 PID ${pid} 占用，但进程名不是 LM Studio；不终止`);
      return { ok: false, stillReachable: true };
    }

    const killed = await this.terminate(pid, { requireLmStudioName: true });
    return this.resultOf(killed);
  }

  /** 终止后复核端点是否仍在响应；`ok` 反映端点最终是否已不可达。 */
  private async resultOf(killed: boolean): Promise<ShutdownResult> {
    const stillReachable = await this.options.adapter.isReachable();
    return { ok: killed && !stillReachable, stillReachable };
  }

  /** 终止指定 PID 的进程树（Windows 用 `taskkill /PID <pid> /T /F`）。 */
  private async terminate(
    pid: number,
    opts: { requireLmStudioName: boolean },
  ): Promise<boolean> {
    const terminate = this.options.terminate ?? terminateProcessTree;
    if (opts.requireLmStudioName) {
      const verify = this.options.isLmStudio ?? isLmStudioProcess;
      if (!(await verify(pid))) return false;
    }
    const ok = await terminate(pid);
    if (!ok) this.options.log?.(`终止 PID ${pid} 失败（已尽力，忽略）`);
    return ok;
  }
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
