import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startService } from './bootstrap.js';

/** 进程入口：启动服务并注册信号关闭路径（DESIGN.md §3.3 / §3.4-B）。 */
const isDirectRun =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  startService()
    .then(({ shutdown }) => {
      process.on('SIGINT', (signal) => shutdown.handleSignal(signal));
      process.on('SIGTERM', (signal) => shutdown.handleSignal(signal));
    })
    .catch((error: unknown) => {
      console.error(`[ots] 启动失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
