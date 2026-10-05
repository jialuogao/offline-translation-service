/**
 * 翻译状态机（DESIGN.md §9.3 / §9.4）。
 *
 * 同一时刻只处理一个在飞请求；已在飞时新的点击被忽略（不入队，§9.4 默认选择）。
 * 只维护一个"正在翻译"行，并记录它所属的合集：切到别的合集发起翻译时，
 * 原合集的行会先收起来（不丢数据：未收到 done 就不会落库）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Lang, TranslateRequest } from '@ots/contracts';
import { errorMessage } from '../api/client';
import { streamTranslation } from '../api/translate';

export interface LiveTranslation {
  collectionId: string;
  sourceText: string;
  sourceLang: Lang;
  targetLang: Lang;
  targetText: string;
  startedAt: string;
}

/** 最近一次成功完成、已落库的翻译；用于输入框下方的输出框。 */
export interface LastResult {
  collectionId: string;
  sourceText: string;
  sourceLang: Lang;
  targetLang: Lang;
  targetText: string;
  entryId: string;
  modelId: string | null;
  finishedAt: string;
}

export interface UseTranslatorResult {
  live: LiveTranslation | null;
  /** 最近一次完成的译文（跨合集保留，按合集区分展示）。 */
  lastResult: LastResult | null;
  /** 指定合集是否有在飞请求；用于禁用该合集的"翻译"按钮与方向切换。 */
  translatingFor: (collectionId: string | null) => boolean;
  /** 是否有任何合集在飞（切合集时用于提示）。 */
  anyInFlight: boolean;
  error: string | null;
  run: (
    request: TranslateRequest,
    onDone?: (result: { entryId: string; modelId: string | null }) => void | Promise<void>,
  ) => Promise<void>;
  /** 丢弃当前"正在翻译"行（done 时 hook 自行收起；取消时也一并清理）。 */
  clearLive: () => void;
  /** 清空输出框里的上一次结果。 */
  dismissResult: () => void;
  cancel: () => void;
  dismissError: () => void;
}

export function useTranslator(): UseTranslatorResult {
  const [live, setLive] = useState<LiveTranslation | null>(null);
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [inFlightCollectionId, setInFlightCollectionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clearLive = useCallback((): void => {
    setLive(null);
  }, []);

  const dismissResult = useCallback((): void => {
    setLastResult(null);
  }, []);

  const cancel = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setInFlightCollectionId(null);
    setLive(null);
  }, []);

  const run = useCallback(
    async (
      request: TranslateRequest,
      onDone?: (result: { entryId: string; modelId: string | null }) => void | Promise<void>,
    ): Promise<void> => {
      if (abortRef.current) {
        // 已在飞：忽略新的点击，不排队。
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setInFlightCollectionId(request.collection_id);
      setError(null);

      const startedAt = new Date().toISOString();
      let finished = false;
      let streamed = '';
      setLive({
        collectionId: request.collection_id,
        sourceText: request.source_text,
        sourceLang: request.source_lang,
        targetLang: request.target_lang,
        targetText: '',
        startedAt,
      });

      try {
        for await (const event of streamTranslation(request, controller.signal)) {
          if (event.type === 'delta') {
            // delta 是增量分片，需累加后展示（§5.3）。
            streamed += event.text;
            const text = streamed;
            setLive((previous) => (previous ? { ...previous, targetText: text } : previous));
          } else {
            finished = true;
            // 先固化输出框内容，再做刷新等收尾工作，避免中间态闪空。
            setLastResult({
              collectionId: request.collection_id,
              sourceText: request.source_text,
              sourceLang: request.source_lang,
              targetLang: request.target_lang,
              targetText: event.done.target_text,
              entryId: event.done.entry_id,
              modelId: event.done.model_id,
              finishedAt: new Date().toISOString(),
            });
            // done 即意味着这次流式输出结束：立刻收起 live，输出框改由 lastResult 供数。
            // 这里不能依赖调用方在 onDone 里清（那样 live 与 lastResult 会同时存在）。
            setLive(null);
            await onDone?.({ entryId: event.done.entry_id, modelId: event.done.model_id });
          }
        }
        if (!finished) {
          setError('翻译流意外结束，未保存任何内容');
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        setError(errorMessage(err));
      } finally {
        abortRef.current = null;
        setInFlightCollectionId(null);
      }
    },
    [],
  );

  const translatingFor = useCallback(
    (collectionId: string | null): boolean =>
      collectionId !== null && inFlightCollectionId === collectionId,
    [inFlightCollectionId],
  );

  // 卸载时中断在飞请求，避免对已卸载组件 setState。
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [],
  );

  return {
    live,
    lastResult,
    translatingFor,
    anyInFlight: inFlightCollectionId !== null,
    error,
    run,
    clearLive,
    dismissResult,
    cancel,
    dismissError: () => {
      setError(null);
    },
  };
}
