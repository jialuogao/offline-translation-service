/**
 * 合集列表状态：列出、切换、新建、重命名、删除（DESIGN.md §5.1 / §9.1）。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  type Collection,
  type CollectionResponse,
  type DeleteCollectionResponse,
} from '@ots/contracts';
import { errorMessage, requestJson } from '../api/client';

export interface UseCollectionsResult {
  collections: Collection[];
  active: Collection | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  select: (id: string) => Promise<void>;
  create: (name: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  /** 删除合集；返回后端给出的删除后 active 合集。 */
  remove: (id: string) => Promise<Collection | null>;
}

function toCollections(body: unknown): Collection[] {
  return Array.isArray(body) ? (body as Collection[]) : [];
}

export function useCollections(onError: (message: string) => void): UseCollectionsResult {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [active, setActive] = useState<Collection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [listBody, activeBody] = await Promise.all([
        requestJson('/api/collections'),
        requestJson('/api/collections/active'),
      ]);
      setCollections(toCollections(listBody));
      const activeCollection = (activeBody as CollectionResponse | undefined)?.collection;
      setActive(activeCollection ?? null);
      setError(null);
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      onError(message);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const select = useCallback(
    async (id: string): Promise<void> => {
      try {
        const body = (await requestJson('/api/collections/active', {
          method: 'PUT',
          body: { id },
        })) as CollectionResponse;
        setActive(body.collection);
        await reload();
      } catch (err) {
        onError(errorMessage(err));
      }
    },
    [onError, reload],
  );

  const create = useCallback(
    async (name: string): Promise<void> => {
      try {
        const trimmed = name.trim();
        const body = (await requestJson('/api/collections', {
          method: 'POST',
          body: trimmed === '' ? {} : { name: trimmed },
        })) as Collection;
        setActive(body);
        await reload();
      } catch (err) {
        onError(errorMessage(err));
      }
    },
    [onError, reload],
  );

  const rename = useCallback(
    async (id: string, name: string): Promise<void> => {
      try {
        await requestJson(`/api/collections/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: { name },
        });
        await reload();
      } catch (err) {
        onError(errorMessage(err));
      }
    },
    [onError, reload],
  );

  const remove = useCallback(
    async (id: string): Promise<Collection | null> => {
      try {
        const body = (await requestJson(`/api/collections/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        })) as DeleteCollectionResponse;
        setActive(body.collection);
        await reload();
        return body.collection;
      } catch (err) {
        onError(errorMessage(err));
        return null;
      }
    },
    [onError, reload],
  );

  return { collections, active, loading, error, reload, select, create, rename, remove };
}
