/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

/**
 * 真实 LM Studio 端到端测试的独立配置（`pnpm test:e2e`）。
 *
 * 与默认配置的关键区别：
 * - 只收 `tests/e2e/**`，因此真实模型测试永不与常规套件同跑；
 * - 超时给到 20 分钟（30B 模型冷加载 + 首个请求可能很慢）；
 * - 不设 `exclude: ['tests/e2e/**']`。
 *
 * 注意：这是 TypeScript 配置，不能写成 tsconfig 风格的 `extends`。
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    // 真实推理是重资源操作，串行执行，避免并发抢占同一个模型实例。
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    fileParallelism: false,
    testTimeout: 1_200_000,
    hookTimeout: 1_800_000,
  },
});
