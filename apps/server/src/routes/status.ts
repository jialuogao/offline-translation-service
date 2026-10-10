import { Router } from 'express';
import type { ServiceHealth } from '../health.js';
import { asyncHandler } from '../http/asyncHandler.js';

/**
 * 服务健康状态路由（DESIGN.md §5.4 `GET /api/service/status`）。
 *
 * 这是**统一反馈端点**：汇报每个子系统的当前状态（db / storage / lmstudio），
 * 而不局限于模型。启动时各模块按顺序经历 `loading` → `ok` / `error`；
 * 调用方（run.ps1 / 未来的 callback / 前端）轮询到 `pending === false` 才算
 * 全部落定，再根据 `ok` 与 `errors` 决定如何呈现。
 */
export function createServiceStatusRouter(health: ServiceHealth): Router {
  const router = Router();

  router.get(
    '/service/status',
    asyncHandler(async (_req, res) => {
      res.json(health.snapshot());
    }),
  );

  return router;
}
