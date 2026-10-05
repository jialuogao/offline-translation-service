/**
 * 当前合集的分页历史（DESIGN.md §5.2 / §9.1）。
 *
 * 每页条数是界面偏好：可被用户调整并记在 localStorage（`PREF_ENTRIES_PAGE_SIZE`），
 * 因此本 hook 接收一个外部 pageSize，而不是用硬编码常量。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Entry, type EntryPage, type Lang } from '@ots/contracts';
import { errorMessage, requestJson } from '../api/client';

/** 与后端默认值一致（DESIGN.md §5.2 / §11 的 MAX_PAGE_SIZE 上限为 200）。 */
export const ENTRIES_PAGE_SIZE = 50;
/** 可选每页条数，同时用作偏好校验的候选集。 */
export const ENTRIES_PAGE_SIZE_OPTIONS = [20, 50, 100, 200] as const;

export interface UseEntriesResult {
  items: Entry[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  loading: boolean;
  error: string | null;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  refresh: () => Promise<void>;
  addEntry: (text: string, sourceLang: Lang, targetLang: Lang) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  batchDelete: (ids: string[]) => Promise<void>;
  clearCollection: () => Promise<void>;
}

export function useEntries(
  collectionId: string | null,
  pageSize: number,
  onError: (message: string) => void,
): UseEntriesResult {
  const [items, setItems] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPageState] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // onError 由 App 用 useCallback 稳定，但仍放 ref 里，避免它变化触发重新拉取。
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const load = useCallback(
    async (targetCollectionId: string, targetPage: number, targetPageSize: number): Promise<void> => {
      setLoading(true);
      try {
        const body = (await requestJson(
          `/api/collections/${encodeURIComponent(targetCollectionId)}/entries?page=${targetPage}&pageSize=${targetPageSize}`,
        )) as EntryPage;
        setItems(body.items);
        setTotal(body.total);
        // 以服务端返回的值为准（服务端会夹取超限/非法的 pageSize）。
        setPageState(body.page);
        setError(null);
      } catch (err) {
        const message = errorMessage(err);
        setItems([]);
        setTotal(0);
        setError(message);
        onErrorRef.current(message);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const pageSizeRef = useRef(pageSize);

  const lastCollectionRef = useRef<string | null | undefined>(undefined);

  /**
   * 只在**合集变化**或**每页条数变化**时重新拉取。
   *
   * 两种变化都必须回到第一页：切换合集后页码没有意义；改条数后旧页码在
   * 新分页下也可能越界。刻意不用 [pageSize] 单独触发，否则偏好从 localStorage
   * 恢复时会多打一次请求。
   */
  useEffect(() => {
    const collectionChanged = lastCollectionRef.current !== collectionId;
    const pageSizeChanged = pageSizeRef.current !== pageSize;
    lastCollectionRef.current = collectionId;
    pageSizeRef.current = pageSize;

    if (collectionId === null) {
      setItems([]);
      setTotal(0);
      setPageState(1);
      return;
    }
    // 合集变了、每页条数变了、或当前页不在第一页，都从第一页重新拉取。
    if (collectionChanged || pageSizeChanged || page !== 1) {
      setPageState(1);
    }
    void load(collectionId, 1, pageSize);
    // page 只用于判断"是否需要回到第一页"，不进依赖，避免翻页时重复拉取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionId, pageSize, load]);

  const setPage = useCallback(
    (next: number): void => {
      if (collectionId === null) {
        return;
      }
      const clamped = Math.max(1, next);
      setPageState(clamped);
      void load(collectionId, clamped, pageSizeRef.current);
    },
    [collectionId, load],
  );

  /** 改每页条数：回到第一页重新拉取（当前页在旧分页下已无意义）。 */
  const setPageSize = useCallback(
    (next: number): void => {
      pageSizeRef.current = next;
      setPageState(1);
      if (collectionId !== null) {
        void load(collectionId, 1, next);
      }
    },
    [collectionId, load],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (collectionId === null) {
      return;
    }
    await load(collectionId, page, pageSizeRef.current);
  }, [collectionId, load, page]);

  const deleteEntry = useCallback(
    async (id: string): Promise<void> => {
      try {
        await requestJson(`/api/entries/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await refresh();
      } catch (err) {
        onErrorRef.current(errorMessage(err));
      }
    },
    [refresh],
  );

  /** 不翻译直接写库（DESIGN.md §5.2）：目标文本与原文相同、模型为空。 */
  const addEntry = useCallback(
    async (text: string, sourceLang: Lang, targetLang: Lang): Promise<void> => {
      if (collectionId === null) {
        return;
      }
      try {
        await requestJson('/api/entries', {
          method: 'POST',
          body: {
            collection_id: collectionId,
            text,
            source_lang: sourceLang,
            target_lang: targetLang,
          },
        });
        setPageState(1);
        await load(collectionId, 1, pageSizeRef.current);
      } catch (err) {
        onErrorRef.current(errorMessage(err));
      }
    },
    [collectionId, load],
  );

  const batchDelete = useCallback(
    async (ids: string[]): Promise<void> => {
      if (ids.length === 0) {
        return;
      }
      try {
        await requestJson('/api/entries/batch-delete', {
          method: 'POST',
          body: { ids },
        });
        await refresh();
      } catch (err) {
        onErrorRef.current(errorMessage(err));
      }
    },
    [refresh],
  );

  const clearCollection = useCallback(async (): Promise<void> => {
    if (collectionId === null) {
      return;
    }
    try {
      await requestJson(`/api/collections/${encodeURIComponent(collectionId)}/entries`, {
        method: 'DELETE',
      });
      setPageState(1);
      await load(collectionId, 1, pageSizeRef.current);
    } catch (err) {
      onErrorRef.current(errorMessage(err));
    }
  }, [collectionId, load]);

  const pageCount = total === 0 ? 1 : Math.ceil(total / pageSize);

  return {
    items,
    total,
    page,
    pageSize,
    pageCount,
    loading,
    error,
    setPage,
    setPageSize,
    refresh,
    addEntry,
    deleteEntry,
    batchDelete,
    clearCollection,
  };
}
