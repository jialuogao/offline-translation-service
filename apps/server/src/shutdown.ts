import type { Server } from 'node:http';
import type { LMStudioProcessManager } from './lmstudio/process.js';

/**
 * 服务关闭编排（DESIGN.md §3.4 / §6.4）。
 *
 * 关闭方向在 2026-10-05 重新决定：**永不终止 LM Studio 进程**，本地服务器保持
 * 运行。停机时唯一与 LM Studio 相关的动作是卸载 `LMSTUDIO_MODEL` 指向的模型
 * （含其全部实例），卸载后用 `lms ps --json` 复核。
 *
 * 两个入口：
 * - HTTP `POST /api/shutdown`：能触达用户。
 * - SIGINT/SIGTERM：无法询问用户，但停机序列与前者完全相同。
 */

export interface ShutdownHooks {
  processManager: LMStudioProcessManager;
  /** 关闭数据库等资源的回调。 */
  closeResources: () => void;
  /**
   * 停止接受新连接的 HTTP server；不传则跳过这一步（测试常用）。
   * **不等待**在途请求结束——SSE 流可能永不会结束，等宽限期过后由 `exit` 统一切断。
   */
  server?: Server;
  /** 自定义"停止接受新连接"的实现，默认 `server.close()`。 */
  stopAcceptingConnections?: (server: Server) => void;
  /** 退出前调用（默认 `process.exit`）。 */
  exit?: (code: number) => void;
  log?: (message: string) => void;
  /** 停机宽限期，让 HTTP 响应先发出去。 */
  gracePeriodMs?: number;
}

export interface ShutdownRequest {
  exitCode?: number;
}

export interface ShutdownResult {
  /** 目标模型已不再驻留。 */
  modelUnloaded: boolean;
  /** 卸载后仍在驻留的目标实例；非空即表示内存没有真正释放。 */
  residual: string[];
  reason?: string;
}

export class ShutdownController {
  private shuttingDown = false;
  private readonly options: ShutdownHooks;
  private server: Server | undefined;

  constructor(options: ShutdownHooks) {
    this.options = options;
  }

  /**
   * 绑定 HTTP server（`bootstrap` 在 `listen` 之后调用）。
   *
   * 装配顺序决定了停机控制器必须先于 HTTP server 创建，而 server 又要先
   * 拿到 app 才能监听，因此用「创建后回填」而不是构造参数。
   */
  attachServer(server: Server): void {
    this.server = server;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * 停机序列（DESIGN.md §3.4 / §6.4）：
   *
   * 1. 幂等闸门：重复请求或重复信号只执行一次。
   * 2. 卸载模型 —— 失败或降级都**只是记录**，绝不回退到任何进程终止手段。
   * 3. 停止接受新连接。
   * 4. 关闭数据库等资源。
   * 5. 等宽限期让响应发出，然后退出。
   */
  async shutdown(requested: ShutdownRequest = {}): Promise<ShutdownResult> {
    if (this.shuttingDown) {
      return { modelUnloaded: false, residual: [], reason: '服务正在关闭' };
    }
    this.shuttingDown = true;

    const unload = await this.unloadModel();

    this.options.log?.(
      unload.ok
        ? `模型已卸载（${unload.unloaded.join(', ') || '本就未驻留'}）；本地服务器保持运行`
        : `模型未卸载：${unload.reason ?? '未知原因'}；本地服务器保持运行，未终止任何进程`,
    );

    this.stopAccepting();

    const exit = this.options.exit ?? ((code: number) => process.exit(code));
    try {
      this.options.closeResources();
    } catch (error) {
      this.options.log?.(
        `关闭资源时出错：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 宽限期：先让 HTTP 响应冲刷出去，再退出。
    // 注意这里**不能**用 .unref()：一旦停止接受新连接后事件循环空掉，
    // 未引用的定时器会被直接丢弃，exit() 永远不会执行。
    const delay = this.options.gracePeriodMs ?? 150;
    setTimeout(() => exit(requested.exitCode ?? 0), delay);
    return { modelUnloaded: unload.ok, residual: unload.residual, reason: unload.reason };
  }

  /** 卸载模型；任何失败都降级为"什么都不做"，不抛出。 */
  private async unloadModel(): Promise<{
    ok: boolean;
    unloaded: string[];
    residual: string[];
    reason?: string;
  }> {
    try {
      const result = await this.options.processManager.unload();
      return {
        ok: result.ok,
        unloaded: result.unloaded,
        residual: result.residual,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
    } catch (error) {
      // 卸载失败是可接受的（§6.4）：残留一个模型远好过杀掉用户的 LM Studio。
      return {
        ok: false,
        unloaded: [],
        residual: [],
        reason: `卸载模型时出错：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** 停止接受新连接；失败不影响后续关库与退出。 */
  private stopAccepting(): void {
    const server = this.server;
    const stop = this.options.stopAcceptingConnections ?? ((s: Server) => s.close());
    if (server === undefined) return;
    try {
      stop(server);
    } catch (error) {
      this.options.log?.(
        `停止接受新连接时出错：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 信号路径（§3.4-B）：不询问用户，停机序列与 HTTP 路径一致
   * （卸载模型 → 关 DB → 退出）。
   * 两个信号都到达时只执行一次。
   */
  handleSignal(signal: NodeJS.Signals): void {
    if (this.shuttingDown) return;
    this.options.log?.(`收到 ${signal}，开始关闭`);
    void this.shutdown({
      exitCode: signal === 'SIGINT' ? 130 : 143,
    });
  }
}