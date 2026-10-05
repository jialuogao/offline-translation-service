/** 二次确认模态（DESIGN.md §9.2 删除前确认 / §5.4 关闭 LM Studio 确认）。 */

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  /** 危险操作用红色确认按钮。 */
  danger?: boolean;
  /** 调用方用于显示"处理中"的标识（必填，长度可为空串）。 */
  busyKey: string;
  action: () => Promise<void> | void;
  /** 可选的次要选项，例如"仅关闭服务"（不关闭 LM Studio）。 */
  secondary?: {
    label: string;
    action: () => Promise<void> | void;
  };
}

export interface ConfirmDialogProps {
  request: ConfirmRequest;
  pending: boolean;
  onConfirm: () => void;
  onSecondary: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  request,
  pending,
  onConfirm,
  onSecondary,
  onCancel,
}: ConfirmDialogProps): JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation" onClick={pending ? undefined : onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 className="modal-title">{request.title}</h2>
        <p className="modal-message">{request.message}</p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={pending}>
            取消
          </button>
          {request.secondary !== undefined ? (
            <button type="button" className="btn" onClick={onSecondary} disabled={pending}>
              {request.secondary.label}
            </button>
          ) : null}
          <button
            type="button"
            className={request.danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? '处理中…' : request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
