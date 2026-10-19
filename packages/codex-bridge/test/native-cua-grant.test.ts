import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createNativeBrowserCuaMcpRuntime } from "../src/native-browser-cua-mcp.js";
import { callNativeCuaBroker, resolveNativeCuaBrokerGrant } from "../src/native-cua-mcp.js";

test("CUA grant validates size, shape and safe generation without dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-grant-validation-"));
  const grantFile = join(root, "grant.json");
  const valid = { socketPath: "fixture", capability: "authority", generation: 1 };
  try {
    for (const invalid of [
      { ...valid, generation: -1 },
      { ...valid, generation: 1.5 },
      { ...valid, generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, extra: true },
      { ...valid, socketPath: "" },
    ]) {
      await writeFile(grantFile, JSON.stringify(invalid));
      await assert.rejects(() =>
        callNativeCuaBroker({
          grantFile,
          signal: new AbortController().signal,
          method: "execute",
          params: {},
          timeoutMs: 100,
          active: new Set(),
          connect: () => assert.fail("invalid grant must not dispatch"),
        }),
      );
    }
    await writeFile(grantFile, " ".repeat(16 * 1024 + 1));
    await assert.rejects(
      () => resolveNativeCuaBrokerGrant({ grantFile, signal: new AbortController().signal }),
      /16 KiB/u,
    );
    await assert.rejects(
      () =>
        resolveNativeCuaBrokerGrant({
          grantFile,
          signal: new AbortController().signal,
          readFile: async () => " ".repeat(16 * 1024 + 1),
        }),
      /16 KiB/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CUA grant demand wait is cancellable and does not retry invalid input", async () => {
  const controller = new AbortController();
  let reads = 0;
  const pending = resolveNativeCuaBrokerGrant({
    grantFile: "/fixture/grant",
    signal: controller.signal,
    readFile: async () => {
      reads += 1;
      controller.abort();
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  await assert.rejects(pending, /abort/u);
  assert.equal(reads, 1);
  await assert.rejects(
    () =>
      resolveNativeCuaBrokerGrant({
        grantFile: "/fixture/grant",
        signal: new AbortController().signal,
        readFile: async () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
      }),
    /denied/u,
  );
});

test("CUA grant read cannot dispatch after cancellation or owner disposal", async () => {
  for (const mode of ["cancel", "dispose"]) {
    const controller = new AbortController();
    let live = true;
    await assert.rejects(
      () =>
        callNativeCuaBroker({
          grantFile: "/fixture/grant",
          signal: controller.signal,
          shouldContinue: () => live,
          readFile: async () => {
            if (mode === "cancel") controller.abort();
            else live = false;
            return JSON.stringify({
              socketPath: "fixture",
              capability: "authority",
              generation: 1,
            });
          },
          method: "execute",
          params: {},
          timeoutMs: 100,
          active: new Set(),
          connect: () => assert.fail("cancelled/disposed grant read must not dispatch"),
        }),
      /abort/u,
    );
  }
});

test("CUA command reports warming as retryable without sending an action", async () => {
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "",
    tokenFile: "",
    browserEnabled: false,
    cuaEnabled: true,
    cuaGrantFile: "/fixture/grant",
    readFile: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    connect: () => assert.fail("warming must not dispatch"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  try {
    await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({
      name: "cua_command",
      arguments: { method: "list_apps" },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse((result.content as { text: string }[])[0]!.text), {
      code: "codez-cua.runtime_warming",
      retryable: true,
      action_sent: false,
      dispatch_status: "not_sent",
    });
  } finally {
    runtime.dispose();
    await Promise.allSettled([client.close(), runtime.server.close()]);
  }
});

test("runtime disposal cancels its grant wait without another file read or dispatch", async () => {
  let reads = 0;
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "",
    tokenFile: "",
    browserEnabled: false,
    cuaEnabled: true,
    cuaGrantFile: "/fixture/grant",
    readFile: async () => {
      reads += 1;
      runtime.dispose();
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    connect: () => assert.fail("disposed runtime must not dispatch"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fixture", version: "0" });
  try {
    await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({
      name: "cua_command",
      arguments: { method: "list_apps" },
    });
    assert.equal(result.isError, true);
    assert.match((result.content as { text: string }[])[0]!.text, /abort/u);
    assert.equal(reads, 1);
  } finally {
    runtime.dispose();
    await Promise.allSettled([client.close(), runtime.server.close()]);
  }
});
