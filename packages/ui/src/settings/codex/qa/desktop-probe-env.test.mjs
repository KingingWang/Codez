import assert from "node:assert/strict";
import test from "node:test";
import { isolatedElectronSandboxEnv } from "./desktop-probe-env.mjs";

test("isolated root Linux GUI probe may start Electron without a sandbox", () => {
  assert.deepEqual(isolatedElectronSandboxEnv("linux", 0), {
    ELECTRON_DISABLE_SANDBOX: "1",
  });
});

test("ordinary GUI launches retain the default Electron sandbox", () => {
  assert.deepEqual(isolatedElectronSandboxEnv("linux", 1000), {});
  assert.deepEqual(isolatedElectronSandboxEnv("darwin", 0), {});
  assert.deepEqual(isolatedElectronSandboxEnv("win32", undefined), {});
});
