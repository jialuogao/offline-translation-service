/**
 * 把界面偏好与 React 状态绑定：挂载时从 localStorage 恢复，之后每次变更写回。
 *
 * 刻意在挂载后读取（而不是放进 useState 的初始值）：首帧用默认值、随即可切换为上次的
 * 选择，避免为了读存储而阻塞首屏。相应地，首帧那次写入必须跳过，否则会用默认值把已保存
 * 的偏好覆盖掉。
 */

import { useEffect, useRef, useState } from 'react';
import { loadEnum, saveEnum } from '../preferences';

export function usePersistentEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  // 记录"是否已经完成过首帧渲染"，用于跳过首帧写回。
  const mounted = useRef(false);

  useEffect(() => {
    const stored = loadEnum(name, allowed, fallback);
    if (stored !== fallback) setValue(stored);
    mounted.current = true;
    // allowed / fallback 都是常量字面量，故意不进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    if (!mounted.current) return;
    saveEnum(name, value, allowed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, value]);

  return [value, setValue];
}
