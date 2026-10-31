import { relative, resolve, sep } from "node:path";
import { isNodeTestSource } from "../unit-test-frameworks.mjs";

const SOURCE_SELECTION = "custom-commit-touches-intersect-final-tree";
const TEST_PATH = /^packages\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const STANDALONE_E2E = /\.e2e\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const packagePath = (file) => file.split("/").slice(0, 2).join("/");
const inAppScope = (file) =>
  typeof file === "string" &&
  TEST_PATH.test(file) &&
  !file.includes("\\") &&
  !file.split("/").includes("..") &&
  !/^packages\/(?:codex-bridge|codez-cua)\//u.test(file) &&
  !/\/(?:test|tests)\/(?:e2e|browser)\//u.test(file);

export async function classifyForkRegressionTests({
  source,
  touchedPaths,
  finalFiles,
  engineeringTests,
  readSource,
}) {
  const present = new Set(finalFiles);
  const manifest = {
    schemaVersion: 1,
    source,
    vitest: [],
    nodeByPackage: {},
    existingEngineering: [],
    standaloneE2e: [],
  };
  const candidates = [...new Set(touchedPaths)]
    .filter((file) => present.has(file) && inAppScope(file))
    .sort();
  for (const file of candidates) {
    if (engineeringTests.has(file)) {
      manifest.existingEngineering.push(file);
    } else if (STANDALONE_E2E.test(file)) {
      manifest.standaloneE2e.push(file);
    } else if (isNodeTestSource(await readSource(file))) {
      (manifest.nodeByPackage[packagePath(file)] ??= []).push(file);
    } else {
      manifest.vitest.push(file);
    }
  }
  validateForkRegressionManifest(manifest);
  return manifest;
}

export function validateForkRegressionManifest(manifest) {
  if (manifest?.schemaVersion !== 1) throw new Error("Unsupported fork regression schema");
  if (
    !/^[a-f0-9]{40}$/u.test(manifest.source?.base ?? "") ||
    !/^[a-f0-9]{40}$/u.test(manifest.source?.head ?? "") ||
    manifest.source?.selection !== SOURCE_SELECTION
  ) {
    throw new Error("Fork regression source must identify fixed historical commits");
  }
  if (
    !manifest.nodeByPackage ||
    typeof manifest.nodeByPackage !== "object" ||
    Array.isArray(manifest.nodeByPackage)
  ) {
    throw new Error("Fork regression Node files must be grouped by package");
  }
  const seen = new Set();
  const checkPaths = (paths, category, group) => {
    if (!Array.isArray(paths)) throw new Error(`Fork regression ${category} must be an array`);
    for (const [index, file] of paths.entries()) {
      if (!inAppScope(file)) throw new Error(`Invalid fork regression path: ${file}`);
      if (seen.has(file)) throw new Error(`Fork regression duplicate path: ${file}`);
      if (index > 0 && paths[index - 1] > file)
        throw new Error(`Fork regression ${category} paths must be sorted`);
      if (group && packagePath(file) !== group)
        throw new Error(`Fork regression Node package mismatch: ${file}`);
      if ((category === "standaloneE2e") !== STANDALONE_E2E.test(file))
        throw new Error(`Standalone E2E cannot enter ${category}: ${file}`);
      seen.add(file);
    }
  };
  checkPaths(manifest.vitest, "vitest");
  for (const [group, files] of Object.entries(manifest.nodeByPackage))
    checkPaths(files, "node", group);
  checkPaths(manifest.existingEngineering, "existingEngineering");
  checkPaths(manifest.standaloneE2e, "standaloneE2e");
}

export function getForkVitestFiles(manifest) {
  validateForkRegressionManifest(manifest);
  return [...manifest.vitest];
}

export function selectForkRegressionFiles(inputs, { root, manifest, availableFiles }) {
  validateForkRegressionManifest(manifest);
  // Bugfix：无文件的 Vitest 调用会扩大到整个 include；定制例外必须显式逐文件选择。
  if (!inputs.length)
    throw new Error("Specify exact admitted Vitest files; fork regressions never default to all");
  const admitted = new Set(manifest.vitest);
  const nodeFiles = new Set(Object.values(manifest.nodeByPackage).flat());
  const engineering = new Set(manifest.existingEngineering);
  const selected = new Set();
  for (const input of inputs) {
    if (input.startsWith("-"))
      throw new Error("Only exact fork regression file paths are accepted, not CLI options");
    const file = relative(root, resolve(root, input)).split(sep).join("/");
    if (nodeFiles.has(file))
      throw new Error(`Use the owning package Node/tsx entrypoint for ${file}`);
    if (engineering.has(file)) throw new Error(`Use test:engineering for ${file}`);
    if (!admitted.has(file)) throw new Error(`Not an admitted fork Vitest file: ${file}`);
    if (availableFiles && !availableFiles.has(file))
      throw new Error(`Admitted fork regression file is missing: ${file}`);
    selected.add(file);
  }
  return [...selected];
}

export function createForkVitestInvocation(files, root) {
  return {
    cwd: root,
    args: [
      resolve(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      resolve(root, "vitest.fork.config.ts"),
      ...files,
    ],
  };
}
