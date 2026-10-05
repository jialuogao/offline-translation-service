// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PREF_ENTRIES_PAGE_SIZE,
  PREF_SOURCE_LANG,
  clearRaw,
  loadEnum,
  loadNumber,
  loadRaw,
  saveEnum,
  saveNumber,
  saveRaw,
} from '../../apps/web/src/preferences';

/**
 * 界面偏好持久化测试（翻译方向"记住上次选择"）。
 *
 * jsdom 不提供 localStorage，这里自己装一个可注入故障的实现：既验证正常读写，
 * 也验证"存储不可用/内容损坏时静默回退默认值"这条容错要求。
 */

const LANG_VALUES = ['zh', 'en'] as const;
const FULL_KEY = `ots:pref:v1:${PREF_SOURCE_LANG}`;

interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function installStorage(options: { failReads?: boolean; failWrites?: boolean } = {}): Map<string, string> {
  const data = new Map<string, string>();
  const storage: FakeStorage = {
    getItem(key) {
      if (options.failReads === true) throw new DOMException('被拒绝', 'SecurityError');
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      if (options.failWrites === true) throw new DOMException('配额已满', 'QuotaExceededError');
      data.set(key, value);
    },
    removeItem(key) {
      data.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  return data;
}

let data: Map<string, string>;

beforeEach(() => {
  data = installStorage();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('偏好读写', () => {
  it('写入后能读回，key 带版本前缀', () => {
    saveRaw(PREF_SOURCE_LANG, 'en');
    expect(data.get(FULL_KEY)).toBe('en');
    expect(loadRaw(PREF_SOURCE_LANG)).toBe('en');
  });

  it('未设置时返回 null', () => {
    expect(loadRaw(PREF_SOURCE_LANG)).toBeNull();
  });

  it('空字符串按未设置处理', () => {
    data.set(FULL_KEY, '');
    expect(loadRaw(PREF_SOURCE_LANG)).toBeNull();
  });

  it('clearRaw 删除该项', () => {
    saveRaw(PREF_SOURCE_LANG, 'en');
    clearRaw(PREF_SOURCE_LANG);
    expect(loadRaw(PREF_SOURCE_LANG)).toBeNull();
  });

  it('枚举读取只接受合法值，其余回退默认', () => {
    expect(loadEnum(PREF_SOURCE_LANG, LANG_VALUES, 'zh')).toBe('zh');

    data.set(FULL_KEY, 'en');
    expect(loadEnum(PREF_SOURCE_LANG, LANG_VALUES, 'zh')).toBe('en');

    // 损坏 / 非法 / 旧版本残留的值都不采纳。
    data.set(FULL_KEY, 'jp');
    expect(loadEnum(PREF_SOURCE_LANG, LANG_VALUES, 'zh')).toBe('zh');

    data.set(FULL_KEY, '{"lang":"en"}');
    expect(loadEnum(PREF_SOURCE_LANG, LANG_VALUES, 'zh')).toBe('zh');
  });

  it('枚举写入会拒绝非法值，不落盘', () => {
    saveEnum(PREF_SOURCE_LANG, 'jp' as 'zh', LANG_VALUES);
    expect(data.has(FULL_KEY)).toBe(false);

    saveEnum(PREF_SOURCE_LANG, 'en', LANG_VALUES);
    expect(data.get(FULL_KEY)).toBe('en');
  });

  it('版本前缀不同的旧值不会被读到（换版本即失效）', () => {
    data.set('ots:pref:v0:source-lang', 'en');
    expect(loadRaw(PREF_SOURCE_LANG)).toBeNull();
  });
});

describe('存储不可用时的容错', () => {
  it('完全没有 localStorage：读回默认值，写入不抛错', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    expect(loadEnum(PREF_SOURCE_LANG, LANG_VALUES, 'zh')).toBe('zh');
    expect(() => saveRaw(PREF_SOURCE_LANG, 'en')).not.toThrow();
    expect(() => clearRaw(PREF_SOURCE_LANG)).not.toThrow();
  });

  it('读取抛异常（如被策略拦截）：回退默认值', () => {
    installStorage({ failReads: true });
    expect(loadEnum(PREF_SOURCE_LANG, LANG_VALUES, 'zh')).toBe('zh');
  });

  it('写入抛异常（配额满）：静默忽略，不影响调用方', () => {
    installStorage({ failWrites: true });
    expect(() => saveEnum(PREF_SOURCE_LANG, 'en', LANG_VALUES)).not.toThrow();
    expect(loadRaw(PREF_SOURCE_LANG)).toBeNull();
  });
});

describe('数字类偏好（每页条数）', () => {
  const SIZES = [20, 50, 100, 200] as const;
  const KEY = `ots:pref:v1:${PREF_ENTRIES_PAGE_SIZE}`;

  it('写入与读取正常值', () => {
    saveNumber(PREF_ENTRIES_PAGE_SIZE, 100, SIZES);
    expect(data.get(KEY)).toBe('100');
    expect(loadNumber(PREF_ENTRIES_PAGE_SIZE, SIZES, 50)).toBe(100);
  });

  it('未设置时返回默认值', () => {
    expect(loadNumber(PREF_ENTRIES_PAGE_SIZE, SIZES, 50)).toBe(50);
  });

  it('损坏或越界的值一律回退默认', () => {
    for (const broken of ['abc', '', '0', '-1', '7', '1000', '50.5', '{"n":50}']) {
      data.set(KEY, broken);
      expect(loadNumber(PREF_ENTRIES_PAGE_SIZE, SIZES, 50)).toBe(50);
    }
  });

  it('写入非法值不会落盘', () => {
    saveNumber(PREF_ENTRIES_PAGE_SIZE, 7, SIZES);
    saveNumber(PREF_ENTRIES_PAGE_SIZE, 50.5, SIZES);
    expect(data.has(KEY)).toBe(false);
  });
});
