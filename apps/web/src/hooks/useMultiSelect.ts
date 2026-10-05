/**
 * 历史列表多选（DESIGN.md §9.2）。
 *
 * 语义：
 * - checkbox：切换单行；
 * - 普通点行：锚点设为该行，且只选中该行；
 * - Ctrl+点击：切换该行选中态（非连续多选）；
 * - Shift+点击：从锚点行到当前行（含两端）整段选中；
 * - 表头 checkbox / 列表聚焦时 Ctrl+A：当前页全选或取消全选。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

export interface UseMultiSelectResult {
  selectedIds: Set<string>;
  selectedCount: number;
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Ctrl+点击：只切换自身，不改变锚点。 */
  toggleKeepAnchor: (id: string) => void;
  /** 普通点击：把锚点设到该行并只选中它。 */
  selectOnly: (index: number, id: string) => void;
  /** Shift+点击：锚点到 index 的闭区间全选。 */
  selectRange: (index: number) => void;
  selectAll: () => void;
  clear: () => void;
  allSelected: boolean;
  someSelected: boolean;
}

export function useMultiSelect(pageIds: string[]): UseMultiSelectResult {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);

  // 刷新后丢弃已不存在的条目，避免用旧 id 发起批量删除。
  useEffect(() => {
    const valid = new Set(pageIds);
    setSelectedIds((previous) => {
      const next = new Set<string>();
      for (const id of previous) {
        if (valid.has(id)) {
          next.add(id);
        }
      }
      // 过滤只会删除，尺寸相同即无变化，可保留原引用避免多余渲染。
      return next.size === previous.size ? previous : next;
    });
  }, [pageIds]);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  const toggle = useCallback((id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleKeepAnchor = useCallback(
    (id: string) => {
      toggle(id);
      const index = pageIds.indexOf(id);
      if (index !== -1) {
        setAnchorIndex(index);
      }
    },
    [pageIds, toggle],
  );

  const selectOnly = useCallback((index: number, id: string) => {
    setSelectedIds(new Set([id]));
    setAnchorIndex(index);
  }, []);

  const selectRange = useCallback(
    (index: number) => {
      const anchor = anchorIndex;
      if (anchor === null) {
        const id = pageIds[index];
        if (id !== undefined) {
          setSelectedIds(new Set([id]));
        }
        setAnchorIndex(index);
        return;
      }
      const from = Math.min(anchor, index);
      const to = Math.max(anchor, index);
      setSelectedIds((previous) => {
        const next = new Set(previous);
        for (let i = from; i <= to; i += 1) {
          const id = pageIds[i];
          if (id !== undefined) {
            next.add(id);
          }
        }
        return next;
      });
    },
    [anchorIndex, pageIds],
  );

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(pageIds));
  }, [pageIds]);

  const clear = useCallback(() => {
    setSelectedIds(new Set());
    setAnchorIndex(null);
  }, []);

  const selectedCount = selectedIds.size;
  const allSelected = useMemo(
    () => pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id)),
    [pageIds, selectedIds],
  );

  return {
    selectedIds,
    selectedCount,
    isSelected,
    toggle,
    toggleKeepAnchor,
    selectOnly,
    selectRange,
    selectAll,
    clear,
    allSelected,
    someSelected: selectedCount > 0,
  };
}
