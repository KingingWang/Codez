import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function isNodeTestSource(source) {
  return /\bfrom\s+["']node:test["']/u.test(source);
}

export function isNodeTestFile(file, root = process.cwd()) {
  return isNodeTestSource(readFileSync(resolve(root, file), "utf8"));
}

export function discoverNodeUnitTests(root = process.cwd()) {
  // fork 测试与上游 Vitest 共存；不能由 Vitest 收集后报空 suite，更不能删掉覆盖。
  return globSync(
    [
      "packages/*/test/**/*.test.ts",
      "packages/*/src/**/contract.test.ts",
      "packages/ui/src/**/*.test.ts",
      "packages/ui/src/**/*.test.tsx",
    ],
    { cwd: root, exclude: ["packages/desktop/test/e2e/**"] },
  )
    .filter((file) => isNodeTestFile(file, root))
    .sort();
}
