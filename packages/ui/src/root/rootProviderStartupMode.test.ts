import assert from "node:assert/strict";
import test from "node:test";
import type { ISystemService } from "@codez/services";
import { resolveRootProviderStartupMode } from "./rootProviderStartupMode.js";

type SystemInfoReader = Pick<ISystemService, "info">;

test("Codex desktop waits for the Host runtime fact and skips legacy Provider startup", async () => {
  let reads = 0;
  const system = {
    async info() {
      reads += 1;
      return { homedir: "/isolated", platform: "linux", agentRuntimeMode: "codex" as const };
    },
  };
  assert.equal(await resolveRootProviderStartupMode(true, system), "codex");
  assert.equal(reads, 1);
});

test("explicit legacy/custom desktop Host and older Host keep Provider startup", async () => {
  for (const agentRuntimeMode of ["legacy", undefined] as const) {
    const system: SystemInfoReader = {
      async info() {
        return { homedir: "/isolated", platform: "linux", agentRuntimeMode };
      },
    };
    assert.equal(await resolveRootProviderStartupMode(true, system), "legacy");
  }
});

test("Web never queries the desktop runtime mode", async () => {
  const system: SystemInfoReader = {
    async info() {
      assert.fail("Web startup does not depend on a Host system-info read");
    },
  };
  assert.equal(await resolveRootProviderStartupMode(false, system), "legacy");
});

test("failed Host-info read retains legacy behavior and reports the failure", async () => {
  const unavailable = new Error("Host unavailable");
  const failures: unknown[] = [];
  const system: SystemInfoReader = {
    async info() {
      throw unavailable;
    },
  };
  assert.equal(
    await resolveRootProviderStartupMode(true, system, (error) => failures.push(error)),
    "legacy",
  );
  assert.deepEqual(failures, [unavailable]);
});
