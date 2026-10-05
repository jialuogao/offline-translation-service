import type { LMStudioProcessManager } from './lmstudio/process.js';

/**
 * 服务关闭编排（DESIGN.md §3.4 / §5.4）。
 *
 * 两类入口：
 * - HTTP `POST /api/shutdown`：能触达用户，`startedByUs === false` 时由前端先弹窗，
 *   再把用户选择以 `closeLmStudio` 传回来。
 * - SIGINT/SIGTERM：无法询问用户，按归属直接决策（§3.4-B）。
 */

export interface ShutdownHooks {
  processManager: LMStudioProcessManager;
  /** 关闭数据库等资源的回调。 */
  closeResources: () => void;
  /** 退出前调用（默认 `process.exit`）。 */
  exit?: (code: number) => void;
  log?: (message: string) => void;
  /** 停机宽限期，让 HTTP 响应先发出去。 */
  gracePeriodMs?: number;
}

export interface ShutdownRequest {
  closeLmStudio?: boolean;
  exitCode?: number;
}

export class ShutdownController {
  private shuttingDown = false;
  private readonly options: ShutdownHooks;

  constructor(options: ShutdownHooks) {
    this.options = options;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * 用户主动关闭服务（§3.4-A）。
   *
   * - `startedByUs === true`：无视 `closeLmStudio`，始终关闭本会话启动的 LM Studio。
   * - `startedByUs === false`：只有 `closeLmStudio === true` 才"尽力"关闭外部实例。
   */
  async shutdown(requested: ShutdownRequest = {}): Promise<{ lmStudioClosed: boolean }> {
    if (this.shuttingDown) return { lmStudioClosed: false };
    this.shuttingDown = true;

    const before = this.options.processManager.status();
    let lmStudioClosed = false;
    try {
      if (before.startedByUs) {
        const result = await this.options.processManager.shutdown({ force: false });
        lmStudioClosed = result.ok;
        this.options.log?.(`已按 PID 关闭本会话启动的 LM Studio（ok=${result.ok}）`);
      } else if (requested.closeLmStudio === true) {
        const result = await this.options.processManager.shutdown({ force: true });
        lmStudioClosed = result.ok;
        this.options.log?.(`按用户确认尽力关闭外部 LM Studio（ok=${result.ok}）`);
      } else {
        this.options.log?.('LM Studio 非本会话启动且用户未要求关闭，保持运行');
      }
    } catch (error) {
      // 关闭 LM Studio 失败是可接受的（§6.4）；不能因此留下数据库未关。
      this.options.log?.(
        `关闭 LM Studio 时出错（已忽略）：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const exit = this.options.exit ?? ((code: number) => process.exit(code));
    try {
      this.options.closeResources();
    } catch (error) {
      this.options.log?.(
        `关闭资源时出错：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const delay = this.options.gracePeriodMs ?? 150;
    setTimeout(() => exit(requested.exitCode ?? 0), delay).unref?.();
    return { lmStudioClosed };
  }

  /**
   * 信号路径（§3.4-B）：不询问用户。
   * `startedByUs === true` 时按 PID 关闭；否则直接跳过外部实例。
   * 两个信号都到达时只执行一次。
   */
  handleSignal(signal: NodeJS.Signals): void {
    if (this.shuttingDown) return;
    this.options.log?.(`收到 ${signal}，开始关闭`);
    void this.shutdown({
      closeLmStudio: false,
      exitCode: signal === 'SIGINT' ? 130 : 143,
    });
  }
}
