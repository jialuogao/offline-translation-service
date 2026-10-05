import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 不会自动捕获 async 处理器的 rejection，这里统一转给错误中间件，
 * 保证错误仍以 `{ error, message }` 形状返回（DESIGN.md §5）。
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
