/**
 * 数字类界面偏好（如历史每页条数）。与 usePersistentEnum 同构，只是走数字校验。
 */

import { useEffect, useRef, useState } from 'react';
import { loadNumber, saveNumber } from '../preferences';

export function usePersistentNumber(
  name: string,
  allowed: readonly number[],
  fallback: number,
): [number, (value: number) => void] {
  const [value, setValue] = useState<number>(fallback);
  const mounted = useRef(false);

  useEffect(() => {
    const stored = loadNumber(name, allowed, fallback);
    if (stored !== fallback) setValue(stored);
    mounted.current = true;
    // allowed / fallback 是常量，故意不进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    if (!mounted.current) return;
    saveNumber(name, value, allowed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, value]);

  return [value, setValue];
}
