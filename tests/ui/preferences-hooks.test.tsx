// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PREF_ENTRIES_PAGE_SIZE, PREF_SOURCE_LANG } from '../../apps/web/src/preferences';
import { usePersistentEnum } from '../../apps/web/src/hooks/usePersistentEnum';
import { usePersistentNumber } from '../../apps/web/src/hooks/usePersistentNumber';

/**
 * 界面偏好 hook 的行为测试（"记住上次的选择"）。
 *
 * 关注三件事：挂载时恢复、变更时写回、以及**首帧不能把已保存的值覆盖成默认值**
 * （这是最容易写错的地方：恢复是异步的，若不跳过首帧写回就会把偏好抹掉）。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LANG_VALUES = ['zh', 'en'] as const;
const SIZE_VALUES = [20, 50, 100, 200] as const;
const LANG_KEY = `ots:pref:v1:${PREF_SOURCE_LANG}`;
const SIZE_KEY = `ots:pref:v1:${PREF_ENTRIES_PAGE_SIZE}`;

let data: Map<string, string>;

beforeEach(() => {
  data = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

interface EnumHandle {
  value: () => string;
  set: (value: string) => void;
  unmount: () => void;
}

function renderEnum(initialStorage?: string): EnumHandle {
  if (initialStorage !== undefined) data.set(LANG_KEY, initialStorage);
  const container = document.createElement('div');
  document.body.append(container);
  const box: { value: string; setter: ((value: string) => void) | null } = {
    value: '',
    setter: null,
  };

  function Probe(): null {
    const [value, setValue] = usePersistentEnum<string>(PREF_SOURCE_LANG, LANG_VALUES, 'zh');
    const ref = useRef(box);
    ref.current.value = value;
    ref.current.setter = setValue;
    return null;
  }

  const root: Root = createRoot(container);
  act(() => {
    root.render(createElement(Probe));
  });

  return {
    value: () => box.value,
    set: (value: string) => {
      act(() => {
        box.setter?.(value);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

interface NumberHandle {
  value: () => number;
  set: (value: number) => void;
  unmount: () => void;
}

function renderNumber(initialStorage?: string): NumberHandle {
  if (initialStorage !== undefined) data.set(SIZE_KEY, initialStorage);
  const container = document.createElement('div');
  document.body.append(container);
  const box: { value: number; setter: ((value: number) => void) | null } = { value: 0, setter: null };

  function Probe(): null {
    const [value, setValue] = usePersistentNumber(PREF_ENTRIES_PAGE_SIZE, SIZE_VALUES, 50);
    const ref = useRef(box);
    ref.current.value = value;
    ref.current.setter = setValue;
    return null;
  }

  const root: Root = createRoot(container);
  act(() => {
    root.render(createElement(Probe));
  });

  return {
    value: () => box.value,
    set: (value: number) => {
      act(() => {
        box.setter?.(value);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('usePersistentEnum（翻译方向）', () => {
  it('挂载时恢复已保存的方向', () => {
    const handle = renderEnum('en');
    expect(handle.value()).toBe('en');
    handle.unmount();
  });

  it('没有保存过时用默认值', () => {
    const handle = renderEnum();
    expect(handle.value()).toBe('zh');
    handle.unmount();
  });

  it('首帧不会把已保存的值覆盖成默认值', () => {
    const handle = renderEnum('en');
    // 挂载完成后，存储里仍应是 en（而不是被默认值 zh 覆盖）。
    expect(data.get(LANG_KEY)).toBe('en');
    handle.unmount();
  });

  it('切换方向会写回存储', () => {
    const handle = renderEnum();
    handle.set('en');
    expect(handle.value()).toBe('en');
    expect(data.get(LANG_KEY)).toBe('en');
    handle.unmount();
  });

  it('重新挂载后沿用上次的选择（模拟刷新页面）', () => {
    const first = renderEnum();
    first.set('en');
    first.unmount();

    const second = renderEnum();
    expect(second.value()).toBe('en');
    second.unmount();
  });

  it('存储里的非法值被忽略并回退默认', () => {
    const handle = renderEnum('jp');
    expect(handle.value()).toBe('zh');
    handle.unmount();
  });

  it('localStorage 不可用时用默认值，且不抛错', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    const handle = renderEnum();
    expect(handle.value()).toBe('zh');
    expect(() => {
      handle.set('en');
    }).not.toThrow();
    expect(handle.value()).toBe('en');
    handle.unmount();
  });
});

describe('usePersistentNumber（历史每页条数）', () => {
  it('挂载时恢复已保存的条数', () => {
    const handle = renderNumber('100');
    expect(handle.value()).toBe(100);
    handle.unmount();
  });

  it('默认 50，且首帧不覆盖已保存值', () => {
    const handle = renderNumber();
    expect(handle.value()).toBe(50);
    handle.unmount();

    const stored = renderNumber('200');
    expect(stored.value()).toBe(200);
    expect(data.get(SIZE_KEY)).toBe('200');
    stored.unmount();
  });

  it('改动写回存储，并在重新挂载后生效', () => {
    const first = renderNumber();
    first.set(20);
    expect(data.get(SIZE_KEY)).toBe('20');
    first.unmount();

    const second = renderNumber();
    expect(second.value()).toBe(20);
    second.unmount();
  });

  it('非候选值被忽略（含越界与损坏内容）', () => {
    for (const broken of ['7', '1000', 'abc', '']) {
      const handle = renderNumber(broken);
      expect(handle.value()).toBe(50);
      handle.unmount();
      data.delete(SIZE_KEY);
    }
  });
});
