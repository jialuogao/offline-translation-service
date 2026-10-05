/**
 * 前端偏好持久化（localStorage）。
 *
 * 只保存**界面偏好**，不保存用户数据：
 * - 会持久化：翻译方向等纯界面选择；
 * - 不持久化：原文、译文输出框内容、翻译历史——这些要么是隐私内容，要么已经在后端
 *   数据库里（当前合集由后端 `meta.active_collection_id` 记住，刷新后自动恢复）。
 *
 * 设计要点：
 * - key 带版本号（`ots:pref:v1:<name>`），将来改结构时旧值会被直接忽略而不是解析出错；
 * - 读取时做类型/枚举校验，非法或损坏的值一律回退默认值；
 * - localStorage 不可用（隐私模式、被策略禁用、配额满）时静默降级为默认值，
 *   绝不因为"记不住设置"而让页面起不来。
 */

const PREFIX = 'ots:pref:v1:';

/** 翻译方向偏好（`zh`/`en`）。 */
export const PREF_SOURCE_LANG = 'source-lang';
/** 历史列表每页条数偏好。 */
export const PREF_ENTRIES_PAGE_SIZE = 'entries-page-size';
/** 上次选中的合集 id（服务端也存 active，这里只用于让浏览器回到你上次的选择）。 */
export const PREF_ACTIVE_COLLECTION = 'active-collection';

function storageKey(name: string): string {
  return `${PREFIX}${name}`;
}

/** 安全拿到 localStorage；不可用时返回 null。 */
function getStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    if (storage === undefined || storage === null) return null;
    // 有些环境下 getItem 本身就会抛（例如被策略拦截），探测一次。
    storage.getItem(PREFIX);
    return storage;
  } catch {
    return null;
  }
}

/** 读取任意字符串偏好；不存在、损坏或版本不符时返回 null。 */
export function loadRaw(name: string): string | null {
  const storage = getStorage();
  if (storage === null) return null;
  try {
    const raw = storage.getItem(storageKey(name));
    return raw === null || raw === '' ? null : raw;
  } catch {
    return null;
  }
}

/** 写入字符串偏好；失败（配额满等）时静默忽略。 */
export function saveRaw(name: string, value: string): void {
  const storage = getStorage();
  if (storage === null) return;
  try {
    storage.setItem(storageKey(name), value);
  } catch {
    /* 存不下就算了，不影响使用 */
  }
}

/** 删除该偏好（用于"重置"）。 */
export function clearRaw(name: string): void {
  const storage = getStorage();
  if (storage === null) return;
  try {
    storage.removeItem(storageKey(name));
  } catch {
    /* 忽略 */
  }
}

/**
 * 读取一个受枚举约束的偏好（如翻译方向 `zh` / `en`）。
 * 只有落在 `allowed` 里的值才会被采用，其余一律回退 `fallback`。
 */
export function loadEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = loadRaw(name);
  if (raw === null) return fallback;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** 写入受枚举约束的偏好（写之前再校验一次，避免把非法值落盘）。 */
export function saveEnum<T extends string>(name: string, value: T, allowed: readonly T[]): void {
  if (!(allowed as readonly string[]).includes(value)) return;
  saveRaw(name, value);
}

/**
 * 读取一个受候选集约束的数字偏好（如历史每页条数）。
 * 只有落在 `allowed` 里的值才被采用，其余一律回退 `fallback`。
 */
export function loadNumber(name: string, allowed: readonly number[], fallback: number): number {
  const raw = loadRaw(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && allowed.includes(parsed) ? parsed : fallback;
}

/** 写入受候选集约束的数字偏好。 */
export function saveNumber(name: string, value: number, allowed: readonly number[]): void {
  if (!Number.isInteger(value) || !allowed.includes(value)) return;
  saveRaw(name, String(value));
}
