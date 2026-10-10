import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { resolveCodezAgentSpawnCwd } from "../src/codez-agent/codezAgentSpawnCwd.js";
it("shares fallback behavior for missing paths, files and ENOTDIR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codez-spawn-cwd-"));
  try {
    const file = join(dir, "file");
    await writeFile(file, "x");
    for (const path of [file, join(file, "child"), join(dir, "missing")]) {
      expect(
        await resolveCodezAgentSpawnCwd({
          requestedCwd: path,
          workspacePath: path,
          spawnFallbackCwd: dir,
        }),
      ).toMatchObject({ cwd: dir, usedFallback: true, cwdExists: true });
    }
    expect(
      await resolveCodezAgentSpawnCwd({
        requestedCwd: file,
        workspacePath: dir,
        spawnFallbackCwd: dir,
      }),
    ).toMatchObject({ cwd: file, usedFallback: false, cwdExists: false });
    expect(
      await resolveCodezAgentSpawnCwd({
        requestedCwd: file,
        workspacePath: file,
        spawnFallbackCwd: join(dir, "missing"),
      }),
    ).toMatchObject({ cwd: file, usedFallback: false, cwdExists: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("falls back for an inaccessible project, without treating it as a database permission error", async () => {
  const probe = vi
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
    .mockResolvedValueOnce({ isDirectory: () => true });
  expect(
    await resolveCodezAgentSpawnCwd(
      { requestedCwd: "/old", workspacePath: "/old", spawnFallbackCwd: "/fallback" },
      probe,
    ),
  ).toMatchObject({ cwd: "/fallback", usedFallback: true });
});
