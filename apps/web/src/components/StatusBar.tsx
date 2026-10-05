/** 顶栏状态区：LM Studio 状态与服务关闭入口（DESIGN.md §5.4 / §9）。 */

import type { LmStudioStatus } from '@ots/contracts';

export interface StatusBarProps {
  status: LmStudioStatus | null;
  loading: boolean;
  error: string | null;
  serviceDown: boolean;
  busyAction: string | null;
  onRefresh: () => void;
  onUnloadModel: () => void;
  onShutdownService: () => void;
}

export function StatusBar({
  status,
  loading,
  error,
  serviceDown,
  busyAction,
  onRefresh,
  onUnloadModel,
  onShutdownService,
}: StatusBarProps): JSX.Element {
  let stateClass = 'status-dot unknown';
  let stateText = '状态未知';
  if (serviceDown) {
    stateClass = 'status-dot down';
    stateText = '服务已关闭';
  } else if (status !== null) {
    stateClass = status.running ? 'status-dot up' : 'status-dot down';
    stateText = status.running ? '运行中' : '未就绪';
  }

  return (
    <header className="statusbar">
      <div className="statusbar-title">
        <h1>离线翻译服务</h1>
        <span className="muted">本机中英互译 · LM Studio 本地推理</span>
      </div>

      <div className="statusbar-status">
        <span className={stateClass} aria-hidden="true" />
        <span className="status-text">LM Studio：{stateText}</span>
        {status !== null && status.running ? (
          <span className="muted">
            {status.modelLoaded !== undefined && status.modelLoaded !== ''
              ? `模型 ${status.modelLoaded}`
              : '未加载模型'}
          </span>
        ) : null}
        {loading ? <span className="muted">正在检测…</span> : null}
        {error !== null && !serviceDown ? (
          <span className="error-text">
            检测失败：{error}
            <button type="button" className="btn btn-mini" onClick={onRefresh}>
              重试
            </button>
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-mini"
          onClick={onRefresh}
          disabled={loading || serviceDown}
        >
          刷新
        </button>
      </div>

      <div className="statusbar-actions">
        <button
          type="button"
          className="btn btn-mini"
          onClick={onUnloadModel}
          disabled={busyAction !== null || serviceDown}
          title="卸载已驻留模型以释放内存；本地服务器继续运行"
        >
          {busyAction === 'lmstudio' ? '正在卸载…' : '卸载模型'}
        </button>
        <button
          type="button"
          className="btn btn-mini btn-danger-outline"
          onClick={onShutdownService}
          disabled={busyAction !== null || serviceDown}
        >
          {busyAction === 'service' ? '正在关闭…' : '关闭服务'}
        </button>
      </div>
    </header>
  );
}
