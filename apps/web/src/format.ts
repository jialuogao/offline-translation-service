/** 展示用格式化工具。 */

import type { Lang } from '@ots/contracts';

const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'short',
  timeStyle: 'medium',
});

/** ISO 8601 UTC 文本转本地时间文本；非法值原样返回。 */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return dateTimeFormat.format(date);
}

/** 方向标签，如 `中 → 英`。 */
export function langLabel(lang: Lang): string {
  return lang === 'zh' ? '中' : '英';
}

/** 方向标签，如 `中 → 英`。 */
export function directionLabel(source: Lang, target: Lang): string {
  return `${langLabel(source)} → ${langLabel(target)}`;
}
