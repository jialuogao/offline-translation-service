import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 定位 LM Studio 的可执行文件（DESIGN.md §6.2，实现时按本机实测修正）。
 *
 * 实测（2026-xx，LM Studio 桌面版）：
 * - `LM Studio.exe --help` 不输出任何内容，桌面版**没有** `server start` 子命令；
 * - 官方 CLI 是 `%USERPROFILE%\.lmstudio\bin\lms.exe`，支持 `lms server start`
 *   （见 DESIGN.md §13 第 1 条开放项的实测结论）。
 *
 * 因此候选顺序为：显式覆盖 → `lms` CLI → 桌面版主程序。
 */

export type LmStudioKind = 'lms-cli' | 'desktop';

export interface LocatedExecutable {
  path: string;
  kind: LmStudioKind;
  /** 探测来源，便于日志与诊断。 */
  source: string;
  /** 启动时使用的参数。 */
  args: string[];
}

export interface LocateOptions {
  /** `LMSTUDIO_EXE` 覆盖值（空表示不覆盖）。 */
  override?: string;
  /** 启动参数覆盖（`LMSTUDIO_START_ARGS`，空白分隔）。 */
  startArgs?: string[];
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** 在 `PATH` 中查找可执行文件（等价于 `where`，不额外起进程）。 */
function searchPath(names: string[]): string | null {
  const raw = process.env.PATH ?? process.env.Path ?? '';
  const dirs = raw.split(path.delimiter).filter((dir) => dir !== '');
  for (const name of names) {
    for (const dir of dirs) {
      for (const candidate of [path.join(dir, name), path.join(dir, `${name}.exe`)]) {
        if (isFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

function readRegistryString(key: string, value: string): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync('reg', ['query', key, '/v', value], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /REG_\w+\s+(.+?)\s*$/m.exec(output);
    return match?.[1] ?? null;
  } catch {
    // 键不存在、reg 不可用或被沙箱拦截：都视为"无注册表信息"。
    return null;
  }
}

function registryCandidates(): Array<{ path: string; source: string }> {
  if (process.platform !== 'win32') return [];
  const hits: Array<{ path: string; source: string }> = [];
  const keys: Array<[string, string]> = [
    ['HKCU\\Software\\LM Studio', 'InstallLocation'],
    ['HKCU\\Software\\LM Studio', 'InstallPath'],
    ['HKCU\\Software\\LMStudio', 'InstallLocation'],
    ['HKLM\\Software\\LM Studio', 'InstallLocation'],
  ];
  for (const [key, value] of keys) {
    const base = readRegistryString(key, value);
    if (base === null || base === '') continue;
    hits.push({ path: path.join(base, 'LM Studio.exe'), source: `registry ${key}\\${value}` });
    hits.push({ path: path.join(base, 'lms.exe'), source: `registry ${key}\\${value}` });
  }
  return hits;
}

function defaultInstallCandidates(): Array<{ path: string; source: string }> {
  if (process.platform !== 'win32') return [];
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES ?? '';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? '';
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const candidates: Array<{ path: string; source: string }> = [];

  const push = (base: string, name: string, source: string): void => {
    if (base !== '') candidates.push({ path: path.join(base, 'LM Studio', name), source });
  };

  push(localAppData ? path.join(localAppData, 'Programs') : '', 'LM Studio.exe', 'default install path');
  push(programFiles, 'LM Studio.exe', 'default install path');
  push(programFilesX86, 'LM Studio.exe', 'default install path');

  // `lms` CLI 随 LM Studio 安装到用户目录。
  if (home !== '') {
    candidates.push({ path: path.join(home, '.lmstudio', 'bin', 'lms.exe'), source: 'lms CLI in user profile' });
    candidates.push({ path: path.join(home, '.cache', 'lm-studio', 'bin', 'lms.exe'), source: 'lms CLI in user cache' });
  }
  if (localAppData !== '') {
    candidates.push({
      path: path.join(localAppData, 'LM-Studio', 'lms.exe'),
      source: 'lms CLI in LOCALAPPDATA',
    });
    candidates.push({
      path: path.join(localAppData, 'Programs', 'lm-studio', 'lms.exe'),
      source: 'lms CLI in LOCALAPPDATA\\Programs',
    });
  }
  return candidates;
}

/**
 * 按优先级定位可执行文件；全部失败返回 `null`（DESIGN.md §6.2 说明：定位失败
 * 不影响后端启动，翻译会降级为 `LMSTUDIO_UNAVAILABLE`）。
 */
export function locateLmStudio(options: LocateOptions = {}): LocatedExecutable | null {
  const override = (options.override ?? '').trim();
  if (override !== '') {
    if (!isFile(override)) return null;
    return build(override, 'LMSTUDIO_EXE', options.startArgs);
  }

  const fromPath = searchPath(['lms', 'lmstudio']);
  if (fromPath !== null) {
    return build(fromPath, 'PATH', options.startArgs);
  }

  for (const candidate of [...defaultInstallCandidates(), ...registryCandidates()]) {
    if (isFile(candidate.path)) return build(candidate.path, candidate.source, options.startArgs);
  }
  return null;
}

/** 由已知路径构造启动信息；`lms` CLI 用 `server start`，桌面版直接启动。 */
export function build(
  exePath: string,
  source: string,
  startArgs?: string[],
): LocatedExecutable {
  const kind: LmStudioKind = /lms\.exe$/i.test(exePath) ? 'lms-cli' : 'desktop';
  const defaults = kind === 'lms-cli' ? ['server', 'start'] : [];
  return {
    path: exePath,
    kind,
    source,
    args: startArgs !== undefined && startArgs.length > 0 ? startArgs : defaults,
  };
}
