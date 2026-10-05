/**
 * 客户端/服务端共享契约（DESIGN.md §5）。
 *
 * 只放类型与常量，不放实现：后端与前端都从这里取形状，避免两端契约漂移。
 */

/** 语言方向取值，DESIGN.md §4.1 entries.source_lang / target_lang。 */
export type Lang = 'zh' | 'en';

/** DESIGN.md §5.1 `Collection`。 */
export interface Collection {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  entry_count: number;
}

/** DESIGN.md §5.2 `Entry`。 */
export interface Entry {
  id: string;
  collection_id: string;
  source_lang: Lang;
  target_lang: Lang;
  source_text: string;
  target_text: string;
  model_id: string | null;
  created_at: string;
}

/** DESIGN.md §5.1 `POST /api/collections`。 */
export interface CreateCollectionRequest {
  name?: string;
}

/** DESIGN.md §5.1 `PUT /api/collections/active`。 */
export interface SetActiveCollectionRequest {
  id: string;
}

/** DESIGN.md §5.1 `PATCH /api/collections/:id`。 */
export interface RenameCollectionRequest {
  name: string;
}

/** DESIGN.md §5.1 `DELETE /api/collections/:id` 的响应：删除后的新 active 合集。 */
export interface DeleteCollectionResponse {
  collection: Collection;
}

/** 所有 `{ collection }` 形状响应的统一类型。 */
export interface CollectionResponse {
  collection: Collection;
}

/** DESIGN.md §5.2 `GET /api/collections/:id/entries`。 */
export interface EntryPage {
  items: Entry[];
  total: number;
  page: number;
  pageSize: number;
}

/** DESIGN.md §5.2 `POST /api/entries`：不翻译直接写库的条目请求体。 */
export interface CreateEntryRequest {
  collection_id: string;
  text: string;
  source_lang: Lang;
  target_lang: Lang;
}

/** DESIGN.md §5.2 `POST /api/entries` 的响应：新创建的条目。 */
export interface CreateEntryResponse {
  entry: Entry;
}

/** DESIGN.md §5.2 `POST /api/entries/batch-delete`。 */
export interface BatchDeleteRequest {
  ids: string[];
}

/** DESIGN.md §5.2 删除类响应的统一形状。 */
export interface DeleteCountResponse {
  deleted: number;
}

/** DESIGN.md §5.3 `POST /api/translate/stream` 请求体。 */
export interface TranslateRequest {
  collection_id: string;
  source_lang: Lang;
  target_lang: Lang;
  source_text: string;
}

/** DESIGN.md §5.3 `delta` 事件。 */
export interface DeltaEvent {
  text: string;
}

/** DESIGN.md §5.3 `done` 事件。 */
export interface DoneEvent {
  entry_id: string;
  target_text: string;
  model_id: string | null;
}

/** DESIGN.md §5 统一错误形状，REST 错误响应体与 SSE `error` 事件 data 同形。 */
export interface ApiError {
  error: string;
  message: string;
}

/**
 * DESIGN.md §5.4 `GET /api/lmstudio/status`。
 *
 * `startedByUs` 与 `pid` 已于 2026-10-05 删除：§6.4 取消了所有基于归属的进程
 * 终止决策，记录的 PID 又是短命 CLI（`lms server start`）的，无诊断价值。
 */
export interface LmStudioStatus {
  running: boolean;
  modelLoaded?: string;
}

/** DESIGN.md §5.4 `GET /api/lmstudio/models`。 */
export interface LmStudioModelsResponse {
  models: string[];
}

/**
 * DESIGN.md §5.4 `POST /api/shutdown`。
 *
 * 请求体已清空：原 `closeLmStudio` 决定是否终止 LM Studio，而 §6.4 规定
 * 服务器恒定保持运行，没有可选项。
 */
export type ShutdownRequest = Record<string, never>;

/**
 * DESIGN.md §5.4 `POST /api/lmstudio/unload`（原 `POST /api/lmstudio/shutdown`）。
 *
 * 无请求体：卸载目标固定为 `LMSTUDIO_MODEL` 及其全部实例，无需归属确认，
 * 因此原先的 409 / `{ force: true }` 流程一并删除。
 */
export type LmStudioUnloadRequest = Record<string, never>;

/**
 * DESIGN.md §5.4 `POST /api/lmstudio/unload` 响应。
 *
 * `residual` 非空表示复核后仍有目标实例驻留——即内存**没有**被释放，
 * 调用方（界面/日志）应据此提示，而不是当作成功。
 */
export interface LmStudioUnloadResponse extends OkResponse {
  unloaded: string[];
  residual?: string[];
  reason?: string;
}

/** DESIGN.md §5.4 `{ ok: boolean }`。 */
export interface OkResponse {
  ok: boolean;
}

/** SSE 事件名（DESIGN.md §5.3）。 */
export const SSE_EVENT_DELTA = 'delta';
export const SSE_EVENT_DONE = 'done';
export const SSE_EVENT_ERROR = 'error';

/** 错误码（DESIGN.md §5.3 / §6.5 / §9.4）。 */
export const ERROR_CODES = {
  /** 原文超长（§11 TRANSLATE_MAX_CHARS）。 */
  inputTooLong: 'INPUT_TOO_LONG',
  /** 请求字段非法或方向非法（§5.3 步骤 1）。 */
  invalidRequest: 'INVALID_REQUEST',
  /** 合集不存在。 */
  collectionNotFound: 'COLLECTION_NOT_FOUND',
  /** 同一合集已有在飞翻译（§9.4）。 */
  translationInFlight: 'TRANSLATION_IN_FLIGHT',
  /** LM Studio 不可达或调用失败（§6.5）。 */
  lmstudioUnavailable: 'LMSTUDIO_UNAVAILABLE',
  /** 未预期的服务端错误。 */
  internal: 'INTERNAL_ERROR',
  /** 请求体不是合法 JSON。 */
  invalidJson: 'INVALID_JSON',
  /** 找不到路由。 */
  notFound: 'NOT_FOUND',
} as const;

/** 分页默认值（DESIGN.md §5.2）。 */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
