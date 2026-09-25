import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createNativeBrowserCuaMcpRuntime } from "../src/native-browser-cua-mcp.js";

test("native browser_command rejects disallowed methods before token or broker connection", async () => {
  let tokenReads = 0;
  let connections = 0;
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "/fixture/native-browser.sock",
    tokenFile: "/fixture/native-browser.token",
    readFile: async () => {
      tokenReads += 1;
      return "fixture-token";
    },
    connect: () => {
      connections += 1;
      throw new Error("broker must not be contacted");
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await assert.rejects(
      () => client.callTool({ name: "browser_command", arguments: { method: "evaluate" } }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /allowed method/u);
        return true;
      },
    );
    assert.equal(tokenReads, 0);
    assert.equal(connections, 0);
  } finally {
    await Promise.allSettled([client.close(), runtime.server.close()]);
    runtime.dispose();
  }
});

test("native browser_command distinguishes token-read failure from broker connection failure", async () => {
  let tokenReads = 0;
  let connections = 0;
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "/fixture/native-browser.sock",
    tokenFile: "/fixture/missing.token",
    readFile: async () => {
      tokenReads += 1;
      throw new Error("token read fixture failed");
    },
    connect: () => {
      connections += 1;
      throw new Error("broker connection fixture failed");
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await assert.rejects(
      () => client.callTool({ name: "browser_command", arguments: { method: "getState" } }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /token read fixture failed/u);
        return true;
      },
    );
    assert.equal(tokenReads, 1);
    assert.equal(connections, 0);
  } finally {
    await Promise.allSettled([client.close(), runtime.server.close()]);
    runtime.dispose();
  }
});
