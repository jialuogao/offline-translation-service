import type {
  ServiceModuleState,
  ServiceModuleStatus,
  ServiceStatus,
} from '@ots/contracts';

/**
 * 服务健康状态机（DESIGN.md §5.4 `GET /api/service/status`）。
 *
 * 职责：忠实汇报每个子系统的当前状态，而不是只报告模型。
 *
 * - 模块按启动顺序依次经历 `loading` → `ok` / `error`：
 *   `db`（数据库）→ `storage`（数据目录可写）→ `lmstudio`（服务器可达 + 模型驻留）。
 * - `loading` 是中间态（可能伴随重试）；`ok` / `error` 是终态。
 * - `snapshot()` 聚合出 `pending`（还有模块在 loading）与 `errors`（所有 error 模块）。
 *   调用方（run.ps1 / 未来的 callback / 前端）轮询到 `pending === false` 才算"全部
 *   落定"，再根据 `ok` 决定如何呈现。
 *
 * 与"致命错误"的关系：db 打不开这类会让整个服务失去意义的错误仍按现状处理
 * （启动失败即退出，进程消失后轮询方以"连接被拒"识别）；这里记录的是服务
 * **选择继续运行**时的状态（模型加载失败、目录写失败等）。
 */
export class ServiceHealth {
  private readonly modules = new Map<string, ServiceModuleStatus>();

  /** 开始某个模块（进入 loading）。 */
  begin(module: string, detail?: string): void {
    this.modules.set(module, { state: 'loading', ...(detail ? { detail } : {}) });
  }

  /** 模块成功（终态 ok）。 */
  succeed(module: string, detail?: string): void {
    this.modules.set(module, { state: 'ok', ...(detail ? { detail } : {}) });
  }

  /** 模块失败（终态 error），记录原因。 */
  fail(module: string, error: string, detail?: string): void {
    this.modules.set(module, {
      state: 'error',
      error,
      ...(detail ? { detail } : {}),
    });
  }

  /** 记录一次重试尝试（保留其它字段，把 state 置回 loading）。 */
  retry(module: string, detail?: string): void {
    const current = this.modules.get(module);
    this.modules.set(module, {
      state: 'loading',
      attempts: (current?.attempts ?? 0) + 1,
      maxAttempts: current?.maxAttempts,
      ...(detail ? { detail } : {}),
    });
  }

  /** 为模块设置尝试上限（开始循环前调用一次）。 */
  setMaxAttempts(module: string, maxAttempts: number): void {
    const current = this.modules.get(module);
    this.modules.set(module, { ...(current ?? { state: 'loading' }), maxAttempts });
  }

  /** 聚合当前快照（§5.4 响应形状）。 */
  snapshot(): ServiceStatus {
    const errors: Array<{ module: string; message: string }> = [];
    let pending = false;
    // 一个模块都没有时不算"全部成功"：调用方应等到模块被驱动后再下结论。
    let ok = this.modules.size > 0;

    for (const [module, status] of this.modules) {
      if (status.state === 'loading') pending = true;
      if (status.state === 'error') {
        ok = false;
        errors.push({ module, message: status.error ?? '未知错误' });
      }
    }

    return { modules: Object.fromEntries(this.modules), pending, ok, errors };
  }
}
