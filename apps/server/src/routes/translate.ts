import { Router, type Request, type Response } from 'express';
import type { Lang } from '@ots/contracts';
import { ErrorCode, badRequest } from '../errors.js';
import type { TranslationService } from '../services/translationService.js';
import { asyncHandler } from '../http/asyncHandler.js';
import { asRecord, requiredString } from '../http/parse.js';

/**
 * 流式翻译路由（DESIGN.md §5.3 / §9.3 / §9.4）。
 *
 * SSE 事件：若干 `delta` → `done`，或单个 `error`。校验类失败在进入 SSE 之前
 * 以普通 JSON 错误返回（400/404/409），客户端据此展示 `message`。
 */

/** 单次响应的最大并发连接数保护（§9.4 建议 ≤ 4）。 */
export function createTranslateRouter(
  translations: TranslationService,
  options: { maxConcurrentStreams: number },
): Router {
  const router = Router();
  let active = 0;

  router.post(
    '/translate/stream',
    asyncHandler(async (req, res) => {
      const body = asRecord(req.body);
      const collectionId = requiredString(body, 'collection_id');
      const sourceLang: unknown = body.source_lang;
      const targetLang: unknown = body.target_lang;
      const sourceText: unknown = body.source_text;

      translations.validate({ collectionId, sourceLang, targetLang, sourceText });
      // 同一合集已有在飞请求 → 409（§9.4）；必须在写 SSE 头之前判断。
      translations.assertNotInFlight(collectionId);

      if (active >= options.maxConcurrentStreams) {
        throw badRequest(
          ErrorCode.translationInFlight,
          `并发翻译数已达上限（${options.maxConcurrentStreams}），请等待当前翻译结束`,
        );
      }

      active += 1;
      let counted = false;
      const release = (): void => {
        if (counted) return;
        counted = true;
        active -= 1;
      };

      try {
        await streamTranslation(
          req,
          res,
          translations,
          {
            collectionId,
            sourceLang: sourceLang as Lang,
            targetLang: targetLang as Lang,
            sourceText: sourceText as string,
          },
          release,
        );
      } finally {
        // streamTranslation 自身已兜底；这里再保证一次，避免并发槽泄漏。
        release();
        if (!res.writableEnded && res.headersSent) res.end();
      }
    }),
  );

  return router;
}

async function streamTranslation(
  req: Request,
  res: Response,
  translations: TranslationService,
  reqBody: { collectionId: string; sourceLang: Lang; targetLang: Lang; sourceText: string },
  release: () => void,
): Promise<void> {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // 本地回环也关掉 Nagle，保证 delta 逐个到达（§7.2 流式回写）。
  res.socket?.setNoDelay(true);

  const controller = new AbortController();
  let aborted = false;

  /*
   * 断开判据用**底层 socket 的 close**，而不是 `req`/`res` 的 close：
   * 实测 Node 26 + Express 4 下，请求体读完后 `req.destroyed` 就已为 true、`req`
   * 也会触发 `close`，用它会把每一次正常请求都误判成客户端断开（SSE 变成空响应）。
   * socket 的 `close` 只在连接真正结束时触发，且响应未结束才说明是客户端中断。
   */
  const socket = req.socket ?? null;
  const onSocketClose = (): void => {
    if (res.writableEnded) return;
    aborted = true;
    // 客户端断开：取消上游 LM Studio 请求，不落库（§9.4）。
    controller.abort();
    release();
  };
  socket?.on('close', onSocketClose);

  try {
    for await (const event of translations.translateStream({
      ...reqBody,
      signal: controller.signal,
    })) {
      if (aborted || res.writableEnded) return;
      switch (event.type) {
        case 'delta':
          writeSse(res, 'delta', { text: event.text });
          break;
        case 'done':
          writeSse(res, 'done', {
            entry_id: event.entry_id,
            target_text: event.target_text,
            model_id: event.model_id,
          });
          break;
        case 'error':
          writeSse(res, 'error', { error: event.code, message: event.message });
          break;
      }
    }
  } catch (error) {
    if (!aborted && !res.writableEnded) {
      writeSse(res, 'error', {
        error: ErrorCode.internal,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    socket?.off('close', onSocketClose);
    // 事件流已写完（或已断开），此后不再需要取消上游。
    aborted = true;
    release();
    if (!res.writableEnded) res.end();
  }
}

function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
