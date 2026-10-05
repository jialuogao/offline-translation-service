import { execFile } from 'node:child_process';

/**
 * `lms` CLI 调用（DESIGN.md §6.4）。
 *
 * 本机实测结论（见 `docs/impl-notes/lmstudio-lifecycle.md`）：
 *
 * 1. `lms` 把进度与成功信息写到 **stderr**，不是 stdout。两者都要捕获，
 *    否则 `| Out-Null` 之类的写法会把唯一有用的信息丢掉。
 * 2. `lms server status` 在没有服务运行时可能不返回。因此**任何** `lms`
 *    调用都必须走带超时的子进程，绝不能以前台阻塞方式调用。
 * 3. `lms unload` 无论成功与否都返回退出码 0（模型未驻留时打印
 *    `Model Not Found`，退出码仍是 0）。**不能用退出码判断成败**，
 *    必须用 `lms ps --json` 复核。
 * 4. 裸 `lms unload` 在驻留模型多于一个时会弹交互式选择列表。
 *    调用方**必须**显式传 identifier 或 `-a`，否则会挂住。
 */

export interface LmsResult {
  /** 进程正常结束（非超时）时为 true；不代表业务成功，见上方第 3 条。 */
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 以带超时的子进程执行一次 `lms` 子命令。 */
export function runLms(exePath: string, args: string[], timeoutMs: number): Promise<LmsResult> {
  return new Promise((resolve) => {
    execFile(
      exePath,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, code: 0, stdout, stderr, timedOut: false });
          return;
        }
        const killed = (error as { killed?: boolean }).killed === true;
        const code = typeof (error as { code?: unknown }).code === 'number'
          ? ((error as { code: number }).code)
          : null;
        resolve({ ok: !killed, code, stdout, stderr, timedOut: killed });
      },
    );
  });
}

/**
 * 解析 `lms ps --json` 的输出为已加载模型的标识数组。
 *
 * 实测：没有任何模型驻留时返回 `[]`（干净 JSON，退出码 0）；有模型时返回
 * 对象数组，每项的 `identifier` 字段才是卸载时**要传的那个值**——
 * 多实例会被 LM Studio 列为 `model`、`model:2`、…
 *
 * 解析失败一律按空列表处理：调用方把它理解为"没有可卸载的模型"，
 * 而不是"全部都没了"，避免误判。
 */
export function parseLoadedIdentifiers(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (trimmed === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const identifiers: string[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue;
    const value = (entry as { identifier?: unknown }).identifier;
    if (typeof value === 'string' && value.trim() !== '') identifiers.push(value.trim());
  }
  return identifiers;
}

/**
 * 目标模型当前驻留的全部实例标识。
 *
 * LM Studio 会把同一模型的多个实例列为 `id`、`id:2`、`id:3`…，
 * 卸载时必须逐个处理，否则会留下残余实例继续占用内存。
 */
export function instancesOf(identifiers: string[], target: string): string[] {
  const wanted = target.trim();
  if (wanted === '') return [];
  return identifiers.filter(
    (id) => id === wanted || id.startsWith(`${wanted}:`),
  );
}