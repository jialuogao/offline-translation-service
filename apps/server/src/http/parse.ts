import { ErrorCode, badRequest } from '../errors.js';

/** 请求体解析辅助：所有路由共用，非法输入统一转成 `INVALID_REQUEST`。 */

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(ErrorCode.invalidRequest, '请求体必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

export function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(ErrorCode.invalidRequest, `${field} 必须是非空字符串`);
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw badRequest(ErrorCode.invalidRequest, `${field} 必须是字符串`);
  }
  return value;
}

export function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw badRequest(ErrorCode.invalidRequest, `${field} 必须是布尔值`);
  }
  return value;
}

export function optionalStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (!Array.isArray(value)) {
    throw badRequest(ErrorCode.invalidRequest, `${field} 必须是字符串数组`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw badRequest(ErrorCode.invalidRequest, `${field} 只能包含非空字符串`);
    }
    return item;
  });
}

export function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}
