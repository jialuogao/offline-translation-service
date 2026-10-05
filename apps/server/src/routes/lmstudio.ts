import { Router } from 'express';
import type { LMStudioAdapter } from '../lmstudio/adapter.js';
import type { LMStudioProcessManager } from '../lmstudio/process.js';
import type { ShutdownController } from '../shutdown.js';
import { asyncHandler } from '../http/asyncHandler.js';

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
    '/lmstudio/unload',
    asyncHandler(async (_req, res) => {
      // §6.4：只卸载 LMSTUDIO_MODEL 指向的模型（含其全部实例），
      // 不终止任何进程、不停止服务器。原先的 409 / force 归属确认流程已删除。
      const result = await processManager.unload();
      if (result.ok) {
        res.json({ ok: true, unloaded: result.unloaded });
        return;
      }
      // 卸载失败是有意义的业务结果（模型仍占内存），但不是服务器错误。
      res.json({
        ok: false,
        unloaded: result.unloaded,
        ...(result.residual.length > 0 ? { residual: result.residual } : {}),
        reason: result.reason ?? '模型卸载失败',
      });
    }),
  );

  return router;
}

/**
 * 关闭整个服务（DESIGN.md §5.4 / §3.4）。响应发出后才真正退出。
 *
 * 请求体已无参数：原 `closeLmStudio` 决定是否终止 LM Studio，而 §6.4 规定
 * 服务器恒定保持运行，停机序列（卸载模型 → 停止接受新连接 → 关 DB）对所有调用
 * 都一样，因此不再有可选项。
 */
export function createShutdownRouter(controller: ShutdownController): Router {
  const router = Router();

  router.post('/shutdown', (_req, res) => {
    res.json({ ok: true });
    // 先让响应冲刷出去，再执行停机（§3.4-A）。
    // 调用方必须轮询到连接被拒才算完成——这里的 ok 只表示"已受理"。
    setImmediate(() => {
      void controller.shutdown().catch((error: unknown) => {
        console.error(
          `[shutdown] 停机失败：${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  });

  return router;
}
