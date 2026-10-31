import { access, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";

export function resolvePatchedDependencyPackageName(key) {
  const value = key.trim();
  const match = value.startsWith("@")
    ? value.match(/^(@[^/]+\/[^@]+)@/u)
    : value.match(/^([^@]+)@/u);
  if (!match?.[1]) {
    throw new Error(`Invalid patched dependency key: ${key}`);
  }
  return match[1];
}

async function pathExists(path) {
  return await access(path).then(
    () => true,
    () => false,
  );
}

/** pnpm 10 的有效 overrides/patches 归 pnpm-workspace.yaml 唯一持有。 */
export async function readWorkspacePatchedDependencies(rootDir) {
  const workspace = parse(await readFile(resolve(rootDir, "pnpm-workspace.yaml"), "utf8"));
  const patchedDependencies = workspace?.patchedDependencies;
  if (patchedDependencies === undefined) return {};
  if (!patchedDependencies || typeof patchedDependencies !== "object" || Array.isArray(patchedDependencies))
    throw new Error("Invalid workspace patchedDependencies");
  return patchedDependencies;
}

export async function clearHoistedPatchedDependencyTargets({ rootDir }) {
  const patchedDependencies = await readWorkspacePatchedDependencies(rootDir);
  const packageNames = Object.keys(patchedDependencies).map(resolvePatchedDependencyPackageName);
  const removed = [];
  for (const packageName of packageNames) {
    const target = join(rootDir, "node_modules", ...packageName.split("/"));
    if (!(await pathExists(target))) continue;
    // Bug 原因：pnpm 10 + node-linker=hoisted 会把 patch 直接应用到目标目录；下一次
    // install 再对已 patch 内容应用同一 diff 并稳定失败。这里只清理可重建的依赖目标，
    // 不碰 store 或用户文件，让 pnpm 从原包重新应用一次 patch。
    await rm(target, { recursive: true, force: true });
    removed.push(packageName);
  }
  return removed;
}
