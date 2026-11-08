import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ReleaseManifest } from "../src/contracts.js";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { ReleaseManager } from "../src/runtime/releaseManager.js";

const temporaryDirs: string[] = [];
const build = { commitSha: "2".repeat(40), commitTimestamp: 200 };

// 固定复刻引入 build 前的线上 Supervisor 合同；不能使用当前 schema 代替旧进程。
const legacyReleaseManifestSchema = z
  .object({
    version: z.string(),
    releaseDir: z.string(),
    releaseId: z.string().optional(),
    appVersion: z.string().optional(),
    target: z.string().optional(),
    nodeVersion: z.string().optional(),
    archiveSha256: z.string().optional(),
  })
  .strict();

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createManifestFixture() {
  const root = await mkdtemp(join(tmpdir(), "codez-release-manager-compat-"));
  temporaryDirs.push(root);
  const layout = resolveServerLayout(join(root, "server"));
  const target: ReleaseManifest = {
    version: "3.17.2",
    releaseDir: join(layout.releasesDir, "3.17.2-linux-x64-newer"),
    releaseId: "3.17.2-linux-x64-newer",
    appVersion: "3.17.2",
    target: "linux-x64",
    nodeVersion: "22.16.0",
    archiveSha256: "2".repeat(64),
    build,
  };
  await mkdir(target.releaseDir, { recursive: true });
  await writeFile(
    join(target.releaseDir, "manifest.json"),
    JSON.stringify({
      product: "codez-server",
      target: "linux-x64",
      appVersion: target.version,
      build,
      nodeVersion: "22.16.0",
      entrypoints: { cli: "server-cli.js", core: "server-core.js", agent: "codez.cjs" },
      native: [],
    }),
  );
  return { layout, target };
}

describe("ReleaseManager cross-version update compatibility", () => {
  it("keeps pending readable by the legacy Supervisor without losing build identity", async () => {
    const { layout, target } = await createManifestFixture();
    const manager = new ReleaseManager(layout);

    await manager.writePending(target);

    const rawPending = JSON.parse(await readFile(layout.pendingFile, "utf8"));
    expect(rawPending).not.toHaveProperty("build");
    expect(legacyReleaseManifestSchema.parse(rawPending)).toEqual(rawPending);
    await expect(manager.readPending()).resolves.toMatchObject({ build });

    // 旧 Supervisor 会原样写回不包含 build 的 current；新 CLI 必须能从 immutable manifest 补全。
    await writeFile(layout.currentFile, JSON.stringify(rawPending));
    await expect(manager.readCurrent()).resolves.toMatchObject({ build });

    await manager.applyPending();
    const applied = JSON.parse(await readFile(layout.currentFile, "utf8"));
    expect(applied.build).toEqual(build);
    await expect(readFile(layout.pendingFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
