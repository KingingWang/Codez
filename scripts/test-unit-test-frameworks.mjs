import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { discoverNodeUnitTests, isNodeTestFile } from "./unit-test-frameworks.mjs";

test("unit framework routing retains native suites and excludes desktop E2E", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codez-test-frameworks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of [
    "packages/shared/test/native.test.ts",
    "packages/shared/test/vitest.test.ts",
    "packages/ui/src/fixture.test.tsx",
    "packages/desktop/test/e2e/native.test.ts",
  ]) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(
      join(root, file),
      file.includes("vitest") ? 'import { test } from "vitest";' : 'import test from "node:test";',
    );
  }
  assert.equal(isNodeTestFile("packages/shared/test/vitest.test.ts", root), false);
  assert.deepEqual(discoverNodeUnitTests(root), [
    "packages/shared/test/native.test.ts",
    "packages/ui/src/fixture.test.tsx",
  ]);
});
