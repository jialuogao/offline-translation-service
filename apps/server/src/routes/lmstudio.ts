import { Router } from 'express';
import { ErrorCode, HttpError } from '../errors.js';
import type { LMStudioAdapter } from '../lmstudio/adapter.js';
import type { LMStudioProcessManager } from '../lmstudio/process.js';
import type { ShutdownController } from '../shutdown.js';
import { asyncHandler } from '../http/asyncHandler.js';
import { asRecord, optionalBoolean } from '../http/parse.js';

/** LM Studio 状态与关闭路由（DESIGN.md §5.4）。 */
export function createLmStudioRouter(
  adapter: LMStudioAdapter,
  processManager: LMStudioProcessManager,
): Router {
  const router = Router();

  router.get(
    '/lmstudio/status',
    asyncHandler(async (_req, res) => {
      res.json(await processManager.probeStatus());
    }),
  );

  router.get(
    '/lmstudio/models',
    asyncHandler(async (_req, res) => {
      try {
        res.json({ models: await adapter.listModels() });
      } catch {
        // 端点不可达时按契约返回空列表，由 /status 表达 running=false。
        res.json({ models: [] });
      }
    }),
  );

  router.post(
    '/lmstudio/shutdown',
    asyncHandler(async (req, res) => {
      const body = req.body === undefined ? {} : asRecord(req.body);
      const force = optionalBoolean(body, 'force') === true;
      const startedByUs = processManager.status().startedByUs;

      if (!startedByUs && !force) {
        // 非本会话启动：前端弹窗确认后带 { force: true } 重试（§5.4 / §6.4）。
        throw new HttpError(
          409,
          ErrorCode.lmstudioNotOwned,
          'LM Studio 不是本服务启动的，关闭它需要用户确认',
        );
      }

      const result = await processManager.shutdown({ force });
      res.json({ ok: result.ok });
    }),
  );

  return router;
}

/** 关闭整个服务（DESIGN.md §5.4 / §3.4）。响应发出后才真正退出。 */
export function createShutdownRouter(controller: ShutdownController): Router {
  const router = Router();

  router.post('/shutdown', (req, res) => {
    const body = req.body === undefined ? {} : asRecord(req.body);
    const closeLmStudio = optionalBoolean(body, 'closeLmStudio') === true;
    res.json({ ok: true });
    // 先让响应冲刷出去，再执行停机（§3.4-A）。
    setImmediate(() => {
      void controller.shutdown({ closeLmStudio }).catch((error: unknown) => {
        console.error(
          `[shutdown] 停机失败：${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  });

  return router;
}
