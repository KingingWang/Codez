import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile } from "@codez/shared";
import { projectStorage } from "#src/project-storage/index.js";
import type { IRemoteProjectService, RemoteProjectHost } from "#src/remote-projects/contract.js";
import {
  createRemoteProjectService,
  createRemoteProjectConnectionAdmission,
  remoteProjectHostIdForProfile,
} from "#src/remote-projects/index.js";

const profile: ConnectionProfile = {
  profileId: "profile",
  transport: "docker",
  target: { kind: "docker", container: "test" },
  createdAt: 1,
};
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fixture() {
  const host: RemoteProjectHost = {
    id: "address",
    membershipId: "original",
    kind: "docker",
    target: profile.target,
    position: 0,
  };
  const service = {
    readDirectory: vi.fn(async () => ({ hosts: [host], entries: [] })),
    saveHost: vi.fn(async () => host),
    bindHost: vi.fn(async () => host),
  } as unknown as IRemoteProjectService;
  return { service, host, admit: createRemoteProjectConnectionAdmission(service) };
}
describe("remote connection membership admission", () => {
  it("resolves both canonical addresses and trusted Source identities using shared identity helpers", () => {
    expect(remoteProjectHostIdForProfile(profile)).toBe("remote:docker:test");
    expect(remoteProjectHostIdForProfile({ ...profile, sourceServerId: "stable" })).toBe(
      "remote:server:stable",
    );
  });
  it("captures membership before the handshake, then commits with that exact generation", async () => {
    const { service, host, admit } = fixture();
    const commit = await admit({ profile, intent: "add", confirmIdentityChange: false });
    expect(service.saveHost).toHaveBeenCalledWith({
      id: remoteProjectHostIdForProfile(profile),
      target: profile.target,
    });
    await commit("stable");
    expect(service.bindHost).toHaveBeenCalledWith({
      id: host.id,
      membershipId: "original",
      resolvedId: "remote:server:stable",
      createDistinctHost: false,
    });
    vi.mocked(service.bindHost).mockResolvedValueOnce(null);
    await expect(commit("stable")).rejects.toThrow("remote-project.host-removed");
    expect(service.saveHost).toHaveBeenCalledTimes(1);
  });
  it("never adds a removed connection on startup or automatic retry", async () => {
    const { service, admit } = fixture();
    vi.mocked(service.readDirectory).mockResolvedValue({ hosts: [], entries: [] });
    await expect(
      admit({ profile, intent: "retain", confirmIdentityChange: false }),
    ).rejects.toThrow("remote-project.host-removed");
    expect(service.saveHost).not.toHaveBeenCalled();
    expect(service.bindHost).not.toHaveBeenCalled();
  });
  it("admits SSH profiles with explicit authMode and rejects unknown authMode in strict SQLite target schema", async () => {
    const db = new DatabaseSync(":memory:");
    const directory = await mkdtemp(join(tmpdir(), "remote-project-auth-mode-test-"));
    cleanups.push(
      () => db.close(),
      () => rm(directory, { recursive: true, force: true }),
    );
    db.exec("PRAGMA foreign_keys=ON");
    await projectStorage.migrate(db, { backupDirectories: [directory] });
    const service = createRemoteProjectService({ database: async () => db });
    const admit = createRemoteProjectConnectionAdmission(service);

    for (const authMode of ["auto", "password", "privateKey"] as const) {
      const sshProfile: ConnectionProfile = {
        profileId: `00000000-0000-4000-8000-${authMode.padEnd(12, "0")}`,
        transport: "ssh",
        target: {
          kind: "ssh",
          host: "30.72.114.100",
          port: 22223,
          username: "root",
          authMode,
          sshConfigAlias: "moga22",
          assetInstallMode: "remote-download",
        },
        createdAt: 1,
      };
      const commit = await admit({
        profile: sshProfile,
        intent: "add",
        confirmIdentityChange: false,
      });
      await commit(`server-${authMode}`);
      const saved = (await service.readDirectory()).hosts.find(
        (item) =>
          item.id === remoteProjectHostIdForProfile({ ...sshProfile, sourceServerId: `server-${authMode}` }),
      );
      expect(saved?.target).toEqual(sshProfile.target);
    }

    await expect(
      service.saveHost({
        id: "remote:ssh:invalid",
        target: {
          kind: "ssh",
          host: "30.72.114.100",
          username: "root",
          authMode: "agent" as unknown as "auto",
        },
      }),
    ).rejects.toThrow(/authMode/);
  });
});
