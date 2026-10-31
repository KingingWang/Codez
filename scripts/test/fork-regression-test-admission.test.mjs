import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  classifyForkRegressionTests,
  createForkVitestInvocation,
  selectForkRegressionFiles,
  validateForkRegressionManifest,
} from "../lib/fork-regression-tests.mjs";
import { isNodeTestSource } from "../unit-test-frameworks.mjs";
import { runForkRegressions } from "../run-fork-regression-tests.mjs";

const source = {
  base: "a".repeat(40),
  head: "b".repeat(40),
  selection: "custom-commit-touches-intersect-final-tree",
};
const ui = "packages/ui/test/custom.test.ts";
const services = "packages/services/test/native.test.ts";
const engineering = "packages/desktop/test/build.test.ts";
const manifest = () => ({
  schemaVersion: 1,
  source,
  vitest: [ui],
  nodeByPackage: { "packages/services": [services] },
  existingEngineering: [engineering],
  standaloneE2e: [],
});

test("historical admission keeps touched-and-restored files but excludes absent and unrelated paths", async () => {
  const removed = "packages/ui/test/removed.test.ts";
  const untouched = "packages/ui/test/upstream-only.test.ts";
  const tests = await classifyForkRegressionTests({
    source,
    touchedPaths: [ui, removed, ui],
    finalFiles: [ui, untouched],
    engineeringTests: new Set(),
    readSource: async () => 'import { test } from "vitest";',
  });
  assert.deepEqual(tests.vitest, [ui]);
  assert.deepEqual(tests.nodeByPackage, {});
});

test("framework routing retains Node provenance and separates existing engineering evidence", async () => {
  const tests = await classifyForkRegressionTests({
    source,
    touchedPaths: [engineering, services, ui],
    finalFiles: [engineering, services, ui],
    engineeringTests: new Set([engineering]),
    readSource: async (file) =>
      file === services ? 'import test from "node:test";' : 'import { test } from "vitest";',
  });
  assert.deepEqual(tests, manifest());
});

test("CLI CUA bridge E2E browser and non-test source never enter the App exception", async () => {
  const paths = [
    "apps/codez-cli/packages/core/tests/runtime.test.ts",
    "packages/codez-cua/broker.test.js",
    "packages/codex-bridge/test/thread-state.test.ts",
    "packages/desktop/test/e2e/conversation.test.ts",
    "packages/ui/test/browser/example.test.mjs",
    "packages/ui/src/new-helper/contract.ts",
  ];
  const tests = await classifyForkRegressionTests({
    source,
    touchedPaths: paths,
    finalFiles: paths,
    engineeringTests: new Set(),
    readSource: async () => {
      assert.fail("excluded paths must not require historical source reads");
    },
  });
  assert.deepEqual(tests.vitest, []);
  assert.deepEqual(tests.nodeByPackage, {});
  assert.deepEqual(tests.existingEngineering, []);
});

test("standalone desktop E2E remains separate from ordinary Node regression files", async () => {
  const e2e = "packages/desktop/test/worktree.e2e.test.mjs";
  const tests = await classifyForkRegressionTests({
    source,
    touchedPaths: [e2e, services],
    finalFiles: [e2e, services],
    engineeringTests: new Set(),
    readSource: async () => 'import test from "node:test";',
  });
  assert.deepEqual(tests.nodeByPackage, { "packages/services": [services] });
  assert.deepEqual(tests.standaloneE2e, [e2e]);
});

test("classification sorts paths and groups reproducibly", async () => {
  const first = "packages/desktop/test/a.test.ts";
  const second = "packages/ui/test/z.test.ts";
  const tests = await classifyForkRegressionTests({
    source,
    touchedPaths: [second, ui, first, services],
    finalFiles: [first, second, services, ui],
    engineeringTests: new Set(),
    readSource: async (file) =>
      file === ui ? 'import { test } from "vitest";' : 'import test from "node:test";',
  });
  assert.deepEqual(Object.keys(tests.nodeByPackage), [
    "packages/desktop",
    "packages/services",
    "packages/ui",
  ]);
  assert.deepEqual(tests.vitest, [ui]);
});

test("manifest validation rejects wrong source, duplicate categories and wrong package grouping", () => {
  assert.doesNotThrow(() => validateForkRegressionManifest(manifest()));
  assert.throws(
    () => validateForkRegressionManifest({ ...manifest(), schemaVersion: 2 }),
    /schema/u,
  );
  assert.throws(
    () =>
      validateForkRegressionManifest({
        ...manifest(),
        source: { ...source, head: "main" },
      }),
    /source/u,
  );
  assert.throws(
    () =>
      validateForkRegressionManifest({
        ...manifest(),
        nodeByPackage: { "packages/ui": [ui] },
      }),
    /duplicate/u,
  );
  assert.throws(
    () =>
      validateForkRegressionManifest({
        ...manifest(),
        nodeByPackage: { "packages/ui": [services] },
      }),
    /package/u,
  );
});

test("selection requires explicit exact admitted Vitest files and cannot widen configuration", () => {
  const root = resolve("/fork-test-workspace");
  const options = { root, manifest: manifest() };
  for (const args of [
    [],
    ["packages/ui/test"],
    ["packages/ui/test/*.test.ts"],
    ["packages/ui/src/new-helper/contract.test.ts"],
    ["--config=vitest.config.ts"],
  ]) {
    assert.throws(() => selectForkRegressionFiles(args, options));
  }
  assert.throws(() => selectForkRegressionFiles([services], options), /Node/u);
  assert.throws(() => selectForkRegressionFiles([engineering], options), /engineering/u);
  assert.deepEqual(selectForkRegressionFiles([ui, resolve(root, ui)], options), [ui]);
});

test("a selected historical file missing from the current tree fails before Vitest starts", () => {
  assert.throws(
    () =>
      selectForkRegressionFiles([ui], {
        root: resolve("/fork-test-workspace"),
        manifest: manifest(),
        availableFiles: new Set(),
      }),
    /missing/u,
  );
});

test("Vitest invocation always uses the isolated config and exact selected paths", () => {
  const root = resolve("/fork-test-workspace");
  const invocation = createForkVitestInvocation([ui], root);
  assert.equal(invocation.cwd, root);
  assert.deepEqual(invocation.args, [
    resolve(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    resolve(root, "vitest.fork.config.ts"),
    ui,
  ]);
});

test("Node detection reuses the existing direct import contract", () => {
  assert.equal(isNodeTestSource('import test from "node:test";'), true);
  assert.equal(isNodeTestSource("import { describe, it } from 'node:test';"), true);
  assert.equal(isNodeTestSource('import { test } from "vitest";'), false);
});

test("runner preserves the actual child exit code without executing App tests in this tool suite", async () => {
  let invocation;
  const root = resolve("/fork-test-workspace");
  const exitCode = await runForkRegressions([ui, ui], {
    root,
    loadManifest: async () => manifest(),
    assertExists: async (_root, file) => assert.equal(file, ui),
    launch: async (plan) => {
      invocation = plan;
      return 7;
    },
  });
  assert.equal(exitCode, 7);
  assert.deepEqual(invocation, createForkVitestInvocation([ui], root));
});

test("runner never starts Vitest for missing files or empty selection", async () => {
  const options = {
    root: resolve("/fork-test-workspace"),
    loadManifest: async () => manifest(),
    assertExists: async () => {
      throw new Error("missing fixture");
    },
    launch: async () => assert.fail("invalid selection must not start Vitest"),
  };
  await assert.rejects(runForkRegressions([], options), /Specify/u);
  await assert.rejects(runForkRegressions([ui], options), /missing/u);
});

test("checked-in admission stays isolated from the engineering list and new governance fixtures", async () => {
  const [registered, engineeringFiles] = await Promise.all([
    readFile(new URL("../fork-regression-test-files.json", import.meta.url), "utf8"),
    readFile(new URL("../engineering-test-files.json", import.meta.url), "utf8"),
  ]);
  const registeredManifest = JSON.parse(registered);
  validateForkRegressionManifest(registeredManifest);
  const engineeringSet = new Set(JSON.parse(engineeringFiles));
  for (const file of [
    ...registeredManifest.vitest,
    ...Object.values(registeredManifest.nodeByPackage).flat(),
  ]) {
    assert.equal(engineeringSet.has(file), false, file);
    assert.notEqual(file, "packages/ui/src/draft-suggested-prompts/contract.test.ts");
  }
  assert.equal(registeredManifest.source.base, "c0695b7f01ad057ff92fd0dca3c5e2df1711f8ba");
  assert.equal(registeredManifest.source.head, "3eafe4fe962b5824ecf2e69392f69900ba19d51d");
});
