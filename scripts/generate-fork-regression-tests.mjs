import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { classifyForkRegressionTests } from "./lib/fork-regression-tests.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = resolve(root, "scripts/fork-regression-test-files.json");
const source = {
  base: "c0695b7f01ad057ff92fd0dca3c5e2df1711f8ba",
  head: "3eafe4fe962b5824ecf2e69392f69900ba19d51d",
  selection: "custom-commit-touches-intersect-final-tree",
};
const execFileAsync = promisify(execFile);
const readGit = async (...args) =>
  (await execFileAsync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout;

export async function generateForkRegressionManifest() {
  await readGit("merge-base", "--is-ancestor", source.base, source.head);
  const [touched, tree, engineering] = await Promise.all([
    // 净 diff 会漏掉曾修改后复原的回归；准入取逐提交触碰并集，再与原最终树相交。
    readGit("log", "--format=", "--name-only", `${source.base}..${source.head}`),
    readGit("ls-tree", "-r", "--name-only", source.head),
    readFile(resolve(root, "scripts/engineering-test-files.json"), "utf8"),
  ]);
  return classifyForkRegressionTests({
    source,
    touchedPaths: touched.split("\n").filter(Boolean),
    finalFiles: tree.split("\n").filter(Boolean),
    engineeringTests: new Set(JSON.parse(engineering)),
    readSource: (file) => readGit("show", `${source.head}:${file}`),
  });
}

export async function main(args) {
  if (args.length !== 1 || !["--check", "--write"].includes(args[0]))
    throw new Error("Use generate-fork-regression-tests.mjs --check or --write");
  const manifest = await generateForkRegressionManifest();
  const generated = `${JSON.stringify(manifest, null, 2)}\n`;
  if (args[0] === "--write") {
    await writeFile(manifestPath, generated);
  } else if ((await readFile(manifestPath, "utf8")) !== generated) {
    throw new Error("Fork regression manifest differs from its fixed historical source");
  }
  const nodeCount = Object.values(manifest.nodeByPackage).reduce(
    (count, files) => count + files.length,
    0,
  );
  console.info(
    `fork regression manifest: ${manifest.vitest.length} Vitest, ${nodeCount} Node, ` +
      `${manifest.existingEngineering.length} existing engineering, ` +
      `${manifest.standaloneE2e.length} standalone E2E`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
