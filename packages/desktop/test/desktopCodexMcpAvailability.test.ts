import assert from "node:assert/strict";
import test from "node:test";
import { localBrowserMcpAvailability } from "../src/main/desktopCodexMcpAvailability.js";
import {
  CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV,
  CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME,
  type DesktopCodexMcpServer,
} from "@codez/shared";

const carrier = (enabled: boolean): DesktopCodexMcpServer => ({
  name: CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME,
  command: process.execPath,
  args: ["bridge.cjs", "native-browser-cua-mcp"],
  env: { [CODEZ_NATIVE_BROWSER_CUA_BROWSER_ENV]: enabled ? "1" : "0" },
});

test("CUA carrier alone cannot authorize this window's browser or remote relay", () => {
  const globalFacts = { browserAvailable: true, cuaAvailable: false };
  assert.equal(localBrowserMcpAvailability(globalFacts, [carrier(false)]).browserAvailable, false);
  assert.equal(localBrowserMcpAvailability(globalFacts, [carrier(true)]).browserAvailable, true);
  assert.equal(localBrowserMcpAvailability(globalFacts, []).browserAvailable, false);
  assert.equal(
    localBrowserMcpAvailability({ ...globalFacts, browserAvailable: false }, [carrier(true)])
      .browserAvailable,
    false,
  );
});
