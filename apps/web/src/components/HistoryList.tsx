/**
 * 右栏下半部：当前合集的历史列表（DESIGN.md §9.1 / §9.2）。
 *
 * 行选择语义：checkbox / 普通点行 / Ctrl+点击 / Shift+点击（详见 useMultiSelect）。
 * 列表区获得焦点时 Ctrl+A 全选当前页；Ctrl+A 在输入框内不受影响。
 */

import { useRef, type MouseEvent } from 'react';
import type { Entry, Lang } from '@ots/contracts';
import { directionLabel, formatDateTime } from '../format';

export interface StreamingRow {
  sourceText: string;
  targetText: string;
  sourceLang: Lang;
  targetLang: Lang;
  startedAt: string;
}

export interface HistoryListProps {
  entries: Entry[];
  streaming: StreamingRow | null;
  loading: boolean;
  error: string | null;
  page: number;
  pageCount: number;
  total: number;
  /** 当前每页条数与可选项；改动后会被记入界面偏好（localStorage）。 */
  pageSize: number;
  pageSizeOptions: readonly number[];
  onPageSizeChange: (pageSize: number) => void;
  selection: {
    selectedIds: Set<string>;
    selectedCount: number;
    allSelected: boolean;
    isSelected: (id: string) => boolean;
    toggle: (id: string) => void;
    toggleKeepAnchor: (id: string) => void;
    selectOnly: (index: number, id: string) => void;
    selectRange: (index: number) => void;
    selectAll: () => void;
    clear: () => void;
  };
  onRefresh: () => void;
  onDeleteEntry: (id: string) => void;
  onBatchDelete: () => void;
  onClearCollection: () => void;
  onPageChange: (page: number) => void;
}

/** 焦点在可输入元素里时不要抢 Ctrl+A。 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

export function HistoryList({
  entries,
  streaming,
  loading,
  error,
  page,
  pageCount,
  total,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  selection,
  onRefresh,
  onDeleteEntry,
  onBatchDelete,
  onClearCollection,
  onPageChange,
}: HistoryListProps): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);
  // 防止批删后紧随的 click 事件把选择又重新加回来。
  const dropSelectionRef = useRef(false);

  const handleRowClick = (
    event: MouseEvent<HTMLDivElement>,
    index: number,
    entry: Entry,
  ): void => {
    if (isEditableTarget(event.target)) {
      return;
    }
    if (dropSelectionRef.current) {
      dropSelectionRef.current = false;
      return;
    }
    // 行内文本被拖动选中时，不要把点击当成选择操作（§9.2）。
    const domSelection = window.getSelection();
    if (domSelection !== null && !domSelection.isCollapsed && domSelection.toString() !== '') {
      return;
    }
    listRef.current?.focus();
    if (event.shiftKey) {
      selection.selectRange(index);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      selection.toggleKeepAnchor(entry.id);
      return;
    }
    // 普通点行：锚点落到该行，且只选中该行。
    selection.selectOnly(index, entry.id);
  };

  return (
    <section className="panel history">
      <div className="panel-header">
        <h2>翻译历史</h2>
        <span className="muted">共 {total} 条</span>
        <label className="page-size">
          <span className="muted">每页</span>
          <select
            value={pageSize}
            disabled={loading}
            onChange={(event) => {
              dropSelectionRef.current = true;
              onPageSizeChange(Number(event.target.value));
            }}
            aria-label="每页条数"
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <span className="muted">条</span>
        </label>
        <div className="panel-header-actions">
          <button type="button" className="btn btn-mini" onClick={onRefresh} disabled={loading}>
            刷新
          </button>
          <button
            type="button"
            className="btn btn-mini btn-danger-outline"
            onClick={onClearCollection}
            disabled={loading || total === 0}
          >
            清空本合集
          </button>
        </div>
      </div>

      {selection.selectedCount > 0 ? (
        <div className="selection-bar">
          <span>已选 {selection.selectedCount} 条</span>
          <button type="button" className="btn btn-mini btn-danger" onClick={onBatchDelete}>
            批量删除
          </button>
          <button type="button" className="btn btn-mini" onClick={selection.clear}>
            取消选择
          </button>
        </div>
      ) : null}

      <div
        className="history-list"
        ref={listRef}
        tabIndex={0}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            if (isEditableTarget(event.target)) {
              return;
            }
            event.preventDefault();
            selection.selectAll();
            return;
          }
          if (event.key === 'Delete' && selection.selectedCount > 0) {
            event.preventDefault();
            onBatchDelete();
          }
        }}
      >
        <div className="history-head">
          <label
            className="cell-check"
            onClick={(event) => {
              event.stopPropagation();
              if (selection.allSelected) {
                selection.clear();
              } else {
                selection.selectAll();
              }
            }}
          >
            <input
              type="checkbox"
              checked={selection.allSelected}
              readOnly
              aria-label="全选当前页"
            />
          </label>
          <span className="cell-source">原文</span>
          <span className="cell-target">译文</span>
          <span className="cell-time">时间</span>
          <span className="cell-direction">方向</span>
          <span className="cell-action" />
        </div>

        {error !== null ? <p className="error-text list-state">加载失败：{error}</p> : null}

        {streaming !== null ? (
          <div className="history-row streaming">
            <span className="cell-check">
              <span className="spinner" aria-hidden="true" />
            </span>
            <span className="cell-source">{streaming.sourceText}</span>
            <span className="cell-target">
              {streaming.targetText === '' ? '正在等待模型输出…' : streaming.targetText}
              <span className="caret" aria-hidden="true" />
            </span>
            <span className="cell-time">{formatDateTime(streaming.startedAt)}</span>
            <span className="cell-direction">
              {directionLabel(streaming.sourceLang, streaming.targetLang)}
            </span>
            <span className="cell-action muted">翻译中</span>
          </div>
        ) : null}

        {loading && entries.length === 0 ? (
          <p className="state list-state">正在加载历史…</p>
        ) : null}

        {!loading && entries.length === 0 && streaming === null && error === null ? (
          <p className="state list-state">该合集还没有翻译记录。</p>
        ) : null}

        {entries.map((entry, index) => (
          <div
            key={entry.id}
            className={selection.isSelected(entry.id) ? 'history-row selected' : 'history-row'}
            onClick={(event) => {
              handleRowClick(event, index, entry);
            }}
          >
            <label
              className="cell-check"
              onClick={(event) => {
                // checkbox 语义：独立切换该项选中态（不改动其他行的选择），并把锚点
                // 移到该行，方便随后 Shift+点击做连续范围选择（§9.2）。
                event.stopPropagation();
                selection.toggleKeepAnchor(entry.id);
              }}
            >
              <input
                type="checkbox"
                checked={selection.isSelected(entry.id)}
                readOnly
                aria-label="选择该条记录"
              />
            </label>
            <span className="cell-source">{entry.source_text}</span>
            <span className="cell-target">{entry.target_text}</span>
            <span className="cell-time">{formatDateTime(entry.created_at)}</span>
            <span className="cell-direction">
              {directionLabel(entry.source_lang, entry.target_lang)}
            </span>
            <span className="cell-action">
              <button
                type="button"
                className="btn btn-mini"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteEntry(entry.id);
                }}
              >
                删除
              </button>
            </span>
          </div>
        ))}
      </div>

      {pageCount > 1 ? (
        <div className="pagination">
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => {
              dropSelectionRef.current = true;
              onPageChange(page - 1);
            }}
            disabled={page <= 1 || loading}
          >
            上一页
          </button>
          <span>
            第 {page} / {pageCount} 页，共 {total} 条
          </span>
          <button
            type="button"
            className="btn btn-mini"
            onClick={() => {
              dropSelectionRef.current = true;
              onPageChange(page + 1);
            }}
            disabled={page >= pageCount || loading}
          >
            下一页
          </button>
        </div>
      ) : null}
    </section>
  );
}
