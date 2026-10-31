import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createForkVitestInvocation,
  selectForkRegressionFiles,
} from "./lib/fork-regression-tests.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const readManifest = async (root) =>
  JSON.parse(await readFile(resolve(root, "scripts/fork-regression-test-files.json"), "utf8"));
const assertFileExists = async (root, file) => {
  try {
    if ((await stat(resolve(root, file))).isFile()) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  throw new Error(`Admitted fork regression file is missing: ${file}`);
};
const launchVitest = (invocation) =>
  new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, invocation.args, {
      cwd: invocation.cwd,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolveExit(exitCode ?? 1));
  });

export async function runForkRegressions(
  inputs,
  {
    root = repoRoot,
    loadManifest = readManifest,
    assertExists = assertFileExists,
    launch = launchVitest,
  } = {},
) {
  const manifest = await loadManifest(root);
  const args = inputs[0] === "--" ? inputs.slice(1) : inputs;
  const files = selectForkRegressionFiles(args, { root, manifest });
  await Promise.all(files.map((file) => assertExists(root, file)));
  return launch(createForkVitestInvocation(files, root));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runForkRegressions(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
