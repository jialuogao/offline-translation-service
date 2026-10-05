import { execFile } from 'node:child_process';

/**
 * Windows 进程查询与终止辅助（DESIGN.md §6.4）。
 *
 * 只用 PID / 端口定位目标，绝不按映像名批量清理；调用方负责先校验进程身份。
 * 本机实测：`Get-NetTCPConnection` 需要权限，普通用户会话报"拒绝访问"，
 * 因此以 `netstat -ano` 为主路径（§6.4 已列为备选）。
 */

const EXEC_TIMEOUT_MS = 5_000;

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', windowsHide: true, timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * 取监听指定端口的 PID。
 *
 * 优先 `netstat -ano`（无需权限），失败时退回 PowerShell `Get-NetTCPConnection`。
 * 有多个候选时选 PID 最小者（通常是父进程），避免误判到子进程。
 */
export async function findPidListeningOnPort(port: number): Promise<number | null> {
  const fromNetstat = await findPidViaNetstat(port);
  if (fromNetstat !== null) return fromNetstat;
  return findPidViaPowerShell(port);
}

async function findPidViaNetstat(port: number): Promise<number | null> {
  let output: string;
  try {
    output = await run('netstat', ['-ano', '-p', 'tcp']);
  } catch {
    return null;
  }
  const pids = new Set<number>();
  for (const rawLine of output.split(/\r?\n/)) {
    const columns = rawLine.trim().split(/\s+/);
    if (columns.length < 5) continue;
    const [protocol, local, , state, pid] = columns;
    if (protocol?.toUpperCase() !== 'TCP') continue;
    if (state?.toUpperCase() !== 'LISTENING') continue;
    if (local === undefined) continue;
    const separator = local.lastIndexOf(':');
    if (separator === -1) continue;
    if (local.slice(separator + 1) !== String(port)) continue;
    const parsed = Number.parseInt(pid ?? '', 10);
    if (Number.isInteger(parsed) && parsed > 0) pids.add(parsed);
  }
  if (pids.size === 0) return null;
  return Math.min(...pids);
}

async function findPidViaPowerShell(port: number): Promise<number | null> {
  try {
    const output = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1 -ExpandProperty OwningProcess)`,
    ]);
    const parsed = Number.parseInt(output.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 校验 PID 的进程名/路径确属 LM Studio，避免误杀占用同一端口的其它进程。
 * 校验失败一律返回 false（宁可不杀）。
 */
export async function isLmStudioProcess(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const output = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const line = output.split(/\r?\n/).find((candidate) => candidate.trim() !== '') ?? '';
    if (line === '') return false;
    const match = /^"([^"]*)","([^"]*)"/.exec(line);
    const imageName = match?.[1] ?? '';
    const sessionName = match?.[2] ?? '';
    return /lm\s*studio/i.test(imageName) || /lm\s*studio/i.test(sessionName);
  } catch {
    return false;
  }
}

/** 终止整棵进程树；返回是否成功（失败即"已尽力"，调用方静默处理）。 */
export async function terminateProcessTree(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      await run('taskkill', ['/PID', String(pid), '/T', '/F']);
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
