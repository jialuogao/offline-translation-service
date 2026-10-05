import fs from 'node:fs';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { ErrorCode, HttpError } from '../errors.js';
import type { CollectionService } from '../services/collectionService.js';
import type { TranslationService } from '../services/translationService.js';
import type { LMStudioAdapter } from '../lmstudio/adapter.js';
import type { LMStudioProcessManager } from '../lmstudio/process.js';
import type { ShutdownController } from '../shutdown.js';
import { createCollectionsRouter } from '../routes/collections.js';
import { createEntriesRouter } from '../routes/entries.js';
import { createLmStudioRouter, createShutdownRouter } from '../routes/lmstudio.js';
import { createTranslateRouter } from '../routes/translate.js';

/**
 * Express 装配（DESIGN.md §3.2 "Web Server"）：静态资源 + REST + SSE。
 *
 * 只做装配与错误整形，不含业务逻辑；所有数据访问经 CollectionService。
 */

export interface AppDependencies {
  collections: CollectionService;
  translations: TranslationService;
  adapter: LMStudioAdapter;
  processManager: LMStudioProcessManager;
  shutdown: ShutdownController;
  /** 前端构建产物目录；不存在时给出可读提示而不是 404。 */
  webRoot: string;
  maxConcurrentStreams: number;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(express.json({ limit: '2mb' }));
  app.use((error: unknown, _req: Request, _res: Response, next: NextFunction) => {
    // express.json 的解析失败：转成统一错误形状（DESIGN.md §5）。
    if (
      error instanceof SyntaxError &&
      'status' in error &&
      (error as { status?: number }).status === 400
    ) {
      next(new HttpError(400, ErrorCode.invalidJson, '请求体不是合法 JSON'));
      return;
    }
    next(error);
  });

  // ---- REST + SSE ----
  // 顺序有意为之：所有路由器都挂在 /api 下并使用全路径，因此 `/collections/:id`
  // 会吞掉 `/collections/:id/entries`。更具体的条目路由必须先注册。
  app.use('/api', createEntriesRouter(deps.collections));
  app.use('/api', createCollectionsRouter(deps.collections));
  app.use('/api', createTranslateRouter(deps.translations, {
    maxConcurrentStreams: deps.maxConcurrentStreams,
  }));
  app.use('/api', createLmStudioRouter(deps.adapter, deps.processManager));
  app.use('/api', createShutdownRouter(deps.shutdown));

  // 未匹配的 /api 路由：统一 JSON 404，避免落到 SPA 回退。
  app.use('/api', (_req, _res, next) => {
    next(new HttpError(404, ErrorCode.notFound, '接口不存在'));
  });

  // ---- 静态资源 ----
  const indexFile = path.join(deps.webRoot, 'index.html');
  if (fs.existsSync(indexFile)) {
    app.use(express.static(deps.webRoot, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => {
      res.sendFile(indexFile);
    });
  } else {
    app.get('*', (_req, res) => {
      res
        .status(503)
        .type('text/plain; charset=utf-8')
        .send('前端尚未构建。请先运行 `pnpm build:web`（或 `pnpm dev`）后刷新页面。');
    });
  }

  // ---- 错误整形（DESIGN.md §5 统一形状）----
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    // 不打印用户原文（隐私边界）；只记录错误本身。
    console.error(`[api] 未预期错误：${message}`);
    res.status(500).json({ error: ErrorCode.internal, message: '服务内部错误' });
  });

  return app;
}
