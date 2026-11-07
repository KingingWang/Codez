import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ServerLayout } from "../src/runtime/paths.js";
import type { ReleaseManifest } from "../src/contracts.js";

const mocks = vi.hoisted(() => ({
  requestControl: vi.fn(),
  installArchive: vi.fn(),
  readCurrent: vi.fn(),
  removePending: vi.fn(),
  markDowngrade: vi.fn(),
}));

vi.mock("../src/ipc/controlClient.js", () => ({
  requestControl: mocks.requestControl,
  isControlEndpointUnavailable: () => false,
}));
vi.mock("../src/runtime/releaseInstaller.js", () => ({
  ReleaseInstaller: class {
    installArchive = mocks.installArchive;
  },
}));
vi.mock("../src/runtime/releaseManager.js", () => ({
  ReleaseManager: class {
    readCurrent = mocks.readCurrent;
    removePending = mocks.removePending;
    markDowngrade = mocks.markDowngrade;
  },
}));
vi.mock("@codez/services/node", () => ({
  createServiceLogger: () => ({ warn: vi.fn() }),
}));

import { runLocalArchiveUpdateCommand } from "../src/runtime/updateCommand.js";

const newerBuild = { commitSha: "2".repeat(40), commitTimestamp: 200 };
const olderBuild = { commitSha: "1".repeat(40), commitTimestamp: 100 };
const current: ReleaseManifest = {
  version: "3.17.2",
  releaseDir: "/server/releases/newer",
  releaseId: "3.17.2-linux-x64-newer",
  archiveSha256: "2".repeat(64),
  build: newerBuild,
};
const target: ReleaseManifest = {
  version: "3.17.2",
  releaseDir: "/server/releases/older",
  releaseId: "3.17.2-linux-x64-older",
  archiveSha256: "1".repeat(64),
  build: olderBuild,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestControl.mockResolvedValue({ status: "ready", runningTaskCount: 0 });
  mocks.readCurrent.mockResolvedValue(current);
  mocks.installArchive.mockResolvedValue(target);
});

describe("same-version Source Server update direction", () => {
  it("rejects an unconfirmed older commit and discards its pending release", async () => {
    const applyUpdate = vi.fn();
    await expect(
      runLocalArchiveUpdateCommand(
        ["update", "--from-archive", "/tmp/older.tar.gz"],
        {},
        true,
        {} as ServerLayout,
        applyUpdate,
      ),
    ).rejects.toMatchObject({ code: "source-server-downgrade-unconfirmed" });
    expect(mocks.removePending).toHaveBeenCalledOnce();
    expect(mocks.markDowngrade).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it("allows the same older commit only after explicit downgrade confirmation", async () => {
    const applyUpdate = vi.fn(async () => undefined);
    const converge = vi.fn(async () => undefined);
    await expect(
      runLocalArchiveUpdateCommand(
        ["update", "--from-archive", "/tmp/older.tar.gz", "--allow-downgrade"],
        {},
        true,
        {} as ServerLayout,
        applyUpdate,
        { converge },
      ),
    ).resolves.toBe(0);
    expect(mocks.markDowngrade).toHaveBeenCalledWith(target, "3.17.2");
    expect(applyUpdate).toHaveBeenCalledOnce();
    expect(converge).toHaveBeenCalledOnce();
  });
});
