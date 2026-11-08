import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReleaseManifest } from "../src/contracts.js";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { createUpdateDaemonHandoff } from "../src/runtime/updateHandoff.js";

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("update daemon handoff", () => {
  it("persists the complete target before stopping the legacy Supervisor", async () => {
    const root = await mkdtemp(join(tmpdir(), "codez-update-handoff-"));
    temporaryDirs.push(root);
    const layout = resolveServerLayout(join(root, "server"));
    const build = { commitSha: "2".repeat(40), commitTimestamp: 200 };
    const target: ReleaseManifest = {
      version: "3.17.2",
      releaseDir: join(layout.releasesDir, "3.17.2-linux-x64-newer"),
      releaseId: "3.17.2-linux-x64-newer",
      build,
    };
    await mkdir(target.releaseDir, { recursive: true });
    const { build: _build, ...legacyCurrent } = target;
    await writeFile(layout.currentFile, JSON.stringify(legacyCurrent));
    let currentAtStop: { build?: unknown } | undefined;
    const stopDaemon = vi.fn(async () => {
      currentAtStop = JSON.parse(await readFile(layout.currentFile, "utf8"));
    });
    const startDaemon = vi.fn(async () => undefined);
    const handoff = createUpdateDaemonHandoff({
      stopDaemon,
      startDaemon,
      readRuntimeIdentity: vi.fn(async () => ({
        supervisorVersion: target.version,
        supervisorReleaseId: target.releaseId,
        activeReleaseVersion: target.version,
        activeReleaseId: target.releaseId,
        coreVersion: target.version,
        coreReleaseId: target.releaseId,
      })),
    });

    await handoff.converge({ layout, previous: null, target });

    const current = JSON.parse(await readFile(layout.currentFile, "utf8"));
    expect(currentAtStop?.build).toEqual(build);
    expect(current.build).toEqual(build);
    expect(stopDaemon).toHaveBeenCalledOnce();
    expect(startDaemon).toHaveBeenCalledWith(layout, target);
    expect(stopDaemon.mock.invocationCallOrder[0]).toBeLessThan(
      startDaemon.mock.invocationCallOrder[0]!,
    );
  });
});
