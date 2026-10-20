import { defineConfig } from "vitest/config";
import upstreamConfig from "./vitest.config";
import { discoverNodeUnitTests } from "./scripts/unit-test-frameworks.mjs";

// 本轮上游集成保留的定制回归使用独立入口，不混入上游 engineering 白名单。
// Node/tsx 测试必须单独执行，不能被 Vitest 的文件发现误计为通过。
export default defineConfig({
  ...upstreamConfig,
  test: {
    ...upstreamConfig.test,
    name: "fork-regression",
    projects: undefined,
    include: [
      "packages/*/test/**/*.test.ts",
      "packages/*/src/**/contract.test.ts",
    ],
    exclude: [
      "packages/desktop/test/e2e/**",
      "packages/codez-cua/**",
      "packages/codex-bridge/**",
      ...discoverNodeUnitTests(__dirname),
    ],
    pool: "forks",
    maxWorkers: 2,
  },
});
