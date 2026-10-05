/**
 * LM Studio 状态与服务关闭（DESIGN.md §5.4 / §6.4 / §9）。
 */

import { useCallback, useEffect, useState } from 'react';
import { type LmStudioStatus, type LmStudioUnloadResponse, type OkResponse } from '@ots/contracts';
import { ApiError, errorMessage, requestJson } from '../api/client';

export interface UseLmStudioStatusResult {
  status: LmStudioStatus | null;
  loading: boolean;
  error: string | null;
  /** 后端已关闭（关闭成功或请求不再可达）。 */
  serviceDown: boolean;
  refresh: () => Promise<void>;
  /** 卸载已驻留模型（服务器继续运行）。返回是否成功及原因。 */
  unloadModel: () => Promise<UnloadOutcome>;
  /** 关闭整个服务（先卸载模型，再关 DB）。 */
  shutdownService: () => Promise<void>;
}

export interface UnloadOutcome {
  ok: boolean;
  message: string;
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

  // §6.4：卸载的是 LMSTUDIO_MODEL 指向的模型，不再有归属确认，
  // 因此不再有 409 / force 重试路径。ok=false 是有意义的业务结果，要如实提示。
  const unloadModel = useCallback(async (): Promise<UnloadOutcome> => {
    const body = (await requestJson('/api/lmstudio/unload', {
      method: 'POST',
    })) as LmStudioUnloadResponse;
    if (body.ok) {
      setStatus((prev) => (prev === null ? prev : { ...prev, modelLoaded: undefined }));
      return {
        ok: true,
        message: body.unloaded.length > 0
          ? `已卸载模型，释放内存。服务器继续运行，需要时会在下次翻译重新加载。`
          : '当前没有驻留模型，无需卸载。',
      };
    }
    return {
      ok: false,
      message: `卸载失败：${body.reason ?? '未知原因'}。可在 LM Studio 中手动卸载。`,
    };
  }, []);

  const shutdownService = useCallback(async (): Promise<void> => {
    // 停机序列包含卸载模型，可能耗时数秒；这里的 ok 仅表示"已受理"。
    const body = (await requestJson('/api/shutdown', { method: 'POST' })) as OkResponse;
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
    unloadModel,
    shutdownService,
  };
}
