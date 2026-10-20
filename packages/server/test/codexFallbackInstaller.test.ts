import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteAssetInstaller } from "../src/remote/remoteAssetInstaller.js";
import { createCodexFallbackInstaller } from "../src/remote/codexFallbackInstaller.js";
import { RemoteAssetSourceUnavailableError } from "../src/remote/remoteAssetPreflight.js";

function fixture(remoteError: Error, warnings: string[] = []) {
  const calls: string[] = [];
  const remote: RemoteAssetInstaller = {
    mode: "remote-download",
    async resolveComponentSha256() {
      return "a".repeat(64);
    },
    async installFile({ componentId }) {
      calls.push(`remote:${componentId}`);
      throw remoteError;
    },
    async installDirectory({ componentId }) {
      calls.push(`remote:${componentId}`);
      throw remoteError;
    },
  };
  const local: RemoteAssetInstaller = {
    mode: "local-download-upload",
    async installFile({ componentId }) {
      calls.push(`local:${componentId}`);
    },
    async installDirectory({ componentId }) {
      calls.push(`local:${componentId}`);
    },
  };
  return {
    calls,
    warnings,
    installer: createCodexFallbackInstaller(remote, local, undefined, {
      logWarn: (message) => warnings.push(String(message)),
    }),
  };
}

test("unavailable remote download switches once to local upload for later components", async () => {
  const f = fixture(new RemoteAssetSourceUnavailableError("remote cannot reach release"));
  assert.equal(f.installer.mode, "remote-download");
  await f.installer.installDirectory({
    componentId: "codex-native",
    sourceRelativePath: "codex",
    remoteDir: "/remote/codex",
  });
  assert.equal(f.installer.mode, "local-download-upload");
  await f.installer.installFile({
    componentId: "codex-bridge",
    sourceRelativePath: "codex-bridge/bridge.cjs",
    remotePath: "/remote/codex/bridge.cjs",
  });
  assert.deepEqual(f.calls, ["remote:codex-native", "local:codex-native", "local:codex-bridge"]);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0]!, /falling back to local download and SSH upload/);
  assert.equal(await f.installer.resolveComponentSha256?.("codex-native"), "a".repeat(64));
});

test("integrity and cancellation errors do not fall back to local upload", async () => {
  for (const message of ["sha256 mismatch", "AbortError"]) {
    const f = fixture(new Error(message));
    await assert.rejects(
      f.installer.installFile({
        componentId: "server-bundle",
        sourceRelativePath: "server/codez-server.cjs",
        remotePath: "/remote/server",
      }),
      /sha256|Abort/,
    );
    assert.deepEqual(f.calls, ["remote:server-bundle"]);
  }
});
