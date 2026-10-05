/**
 * LM Studio 状态与服务关闭（DESIGN.md §5.4 / §6.4 / §9）。
 */

import { useCallback, useEffect, useState } from 'react';
import { type LmStudioStatus, type OkResponse } from '@ots/contracts';
import { ApiError, errorMessage, requestJson } from '../api/client';

export interface UseLmStudioStatusResult {
  status: LmStudioStatus | null;
  loading: boolean;
  error: string | null;
  /** 后端已关闭（关闭成功或请求不再可达）。 */
  serviceDown: boolean;
  refresh: () => Promise<void>;
  /** 仅关闭 LM Studio；非本会话启动时抛 409 `LMSTUDIO_NOT_OWNED`。 */
  shutdownLmStudio: (force: boolean) => Promise<void>;
  /** 关闭整个服务；closeLmStudio 仅在 LM Studio 非本会话启动时有意义。 */
  shutdownService: (closeLmStudio: boolean) => Promise<void>;
}

export function useLmStudioStatus(): UseLmStudioStatusResult {
  const [status, setStatus] = useState<LmStudioStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [serviceDown, setServiceDown] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const body = (await requestJson('/api/lmstudio/status')) as LmStudioStatus;
      setStatus(body);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.isNetworkError) {
        setServiceDown(true);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shutdownLmStudio = useCallback(async (force: boolean): Promise<void> => {
    // 失败（含 409 LMSTUDIO_NOT_OWNED）交给调用方决定是否带 force 重试。
    await requestJson('/api/lmstudio/shutdown', { method: 'POST', body: { force } });
    setStatus({ running: false, startedByUs: false });
  }, []);

  const shutdownService = useCallback(async (closeLmStudio: boolean): Promise<void> => {
    const body = (await requestJson('/api/shutdown', {
      method: 'POST',
      body: { closeLmStudio },
    })) as OkResponse;
    if (body.ok) {
      setServiceDown(true);
    }
  }, []);

  return {
    status,
    loading,
    error,
    serviceDown,
    refresh,
    shutdownLmStudio,
    shutdownService,
  };
}
