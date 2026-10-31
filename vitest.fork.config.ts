import { defineConfig } from "vitest/config";
import upstreamConfig from "./vitest.config";
import forkRegressionTests from "./scripts/fork-regression-test-files.json";
import { getForkVitestFiles } from "./scripts/lib/fork-regression-tests.mjs";

// 本轮上游集成保留的定制回归使用独立入口，不混入上游 engineering 白名单。
// Node/tsx 测试必须单独执行，不能被 Vitest 的文件发现误计为通过。
export default defineConfig({
  ...upstreamConfig,
  test: {
    ...upstreamConfig.test,
    name: "fork-regression",
    projects: undefined,
    // Bugfix：旧通配会自动收集新治理夹具；只接纳原定制历史中登记的既有回归。
    include: getForkVitestFiles(forkRegressionTests),
    exclude: ["packages/desktop/test/e2e/**", "packages/codez-cua/**", "packages/codex-bridge/**"],
    pool: "forks",
    maxWorkers: 2,
  },
});
