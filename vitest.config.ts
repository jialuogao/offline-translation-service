/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
  // DOM 测试在仓库根运行，而 React 同时存在于根与 apps/web 的 node_modules；
  // 若解析到不同副本，hooks 会报 "Cannot read properties of null (reading 'useState')"。
  // dedupe 强制只保留一份 React。
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  test: {
    // 只跑无外部依赖的测试。真实 LM Studio 的端到端测试在 tests/e2e，
    // 由 vitest.e2e.config.ts / `pnpm test:e2e` 单独执行，绝不混入本套件。
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**'],
    // 集成测试会起 HTTP 服务并 spawn 短命子进程，串行执行以保证端口与 PID 无歧义。
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
