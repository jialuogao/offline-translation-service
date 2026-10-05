import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（`tests/helpers/paths.ts` 向上两级）。 */
export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * 测试 scratch 目录，固定在仓库 `.temp/`（AGENTS.md 明确不使用系统临时目录）。
 */
export function scratchDir(...segments: string[]): string {
  const dir = path.join(repoRoot(), '.temp', 'tests', ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 删除某个 scratch SQLite 文件及其 WAL/SHM 边车文件。
 *
 * **每个测试都要在结束时调用它。** `scratchDir()` 只建目录、不做任何清理，
 * 忘记删的话 `.temp/tests/` 会随每次 `pnpm test` 无限累积。
 * （`tests/server/` 之所以是干净的，就是因为 `context.ts#close()` 调了它。）
 */
export function removeDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${dbPath}${suffix}`;
    try {
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    } catch {
      /* scratch 清理失败不应影响断言结果 */
    }
  }
}

/**
 * 在**安全端口区间**内监听，返回真实端口。
 *
 * 不要用 `server.listen(0)`：Windows 分配的临时端口可能落到 Node `fetch` 拒绝连接的
 * 端口上（如 6543），表现为随机的 `TypeError: fetch failed / bad port`。这类偶发失败
 * 会掩盖真实缺陷，因此这里显式从 49152–65535 里挑一个空闲端口。
 *
 * @param listen `(port) => Promise<void>`；只有 EADDRINUSE 会重试，其它错误原样抛出。
 * @param fixedPort 传入固定端口时只用它试一次（测试里想钉住端口的场景）。
 * @param attempts 最多尝试次数。
 */
export async function listenOnSafePort(
  listen: (port: number) => Promise<void>,
  fixedPort?: number,
  attempts = 20,
): Promise<number> {
  if (fixedPort !== undefined) {
    await listen(fixedPort);
    return fixedPort;
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = 49152 + Math.floor(Math.random() * (65535 - 49152 + 1));
    try {
      await listen(port);
      return port;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(
    `在安全端口区间内尝试 ${attempts} 次仍无法监听：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** 安全端口区间的下界，供测试断言使用。 */
export const SAFE_PORT_MIN = 49152;
