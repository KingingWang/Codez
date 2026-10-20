import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  NATIVE_BROWSER_CUA_MCP_CUA_METHODS,
  nativeBrowserCuaMcpBrowserCommandJsonSchema,
  nativeBrowserCuaMcpCuaCommandJsonSchema,
  nativeBrowserCuaMcpCuaCommandSchema,
} from "@codez/shared";
import { createNativeBrowserCuaMcpRuntime } from "../src/native-browser-cua-mcp.js";

type JsonSchema = Record<string, unknown>;

test("CUA advertised fields are derived from the runtime contract without browser schema pollution", () => {
  const schema = nativeBrowserCuaMcpCuaCommandJsonSchema;
  const properties = schema.properties as Record<string, JsonSchema>;
  const variants = z.toJSONSchema(nativeBrowserCuaMcpCuaCommandSchema, {
    io: "input",
    reused: "inline",
  }).oneOf as Array<{ properties: Record<string, JsonSchema> }>;
  const expectedFields = new Set<string>();
  for (const variant of variants) {
    for (const field of Object.keys(variant.properties)) expectedFields.add(field);
  }
  assert.deepEqual(Object.keys(properties).sort(), [...expectedFields].sort());
  for (const field of expectedFields) {
    if (field === "method") continue;
    const definitions = variants.map((variant) => variant.properties[field]).filter(Boolean);
    const unique = [...new Set(definitions.map((definition) => JSON.stringify(definition)))].map(
      (definition) => JSON.parse(definition) as JsonSchema,
    );
    assert.deepEqual(properties[field], unique.length === 1 ? unique[0] : { anyOf: unique }, field);
  }
  assert.deepEqual(properties.method?.enum, [...NATIVE_BROWSER_CUA_MCP_CUA_METHODS]);
  assert.deepEqual(schema.required, ["method"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(properties.modifiers?.type, "string");
  assert.equal(properties.include_screenshot?.type, "boolean");
  assert.equal(properties.url, undefined);
  assert.equal(properties.fromRef, undefined);
  const browserProperties = nativeBrowserCuaMcpBrowserCommandJsonSchema.properties as Record<
    string,
    JsonSchema
  >;
  assert.equal(browserProperties.target, undefined);
  assert.equal(browserProperties.modifiers?.type, "array");
  assert.notDeepEqual(properties.to, browserProperties.to);
});

test("every advertised target field accepts only the four supported JSON shapes", () => {
  const properties = nativeBrowserCuaMcpCuaCommandJsonSchema.properties as Record<
    string,
    JsonSchema
  >;
  for (const field of ["target", "from_target", "to"]) {
    const schema = properties[field];
    assert.ok(schema);
    assert.equal((schema.anyOf as unknown[])?.length, 4, `${field} must have a typed union`);
    const validator = z.fromJSONSchema(schema);
    for (const target of [
      7,
      [40, 60],
      { type: "element", index: 7 },
      { type: "coordinate", x: 40, y: 60, frame_id: "fixture-frame" },
    ]) {
      assert.equal(
        validator.safeParse(target).success,
        true,
        `${field}: ${JSON.stringify(target)}`,
      );
    }
    for (const target of [
      "7",
      "[40,60]",
      "40,60",
      { x: 40, y: 60 },
      -1,
      0.5,
      [40],
      [40, 60, 80],
      [40, -1],
      { type: "element", index: 7, extra: true },
    ]) {
      assert.equal(
        validator.safeParse(target).success,
        false,
        `${field}: ${JSON.stringify(target)}`,
      );
    }
  }
});

test("MCP listing preserves the complete CUA contract and dispatch preserves target JSON types", async () => {
  const dispatched: Array<{ method: string; input: Record<string, unknown> }> = [];
  class FixtureSocket extends EventEmitter {
    destroy(): void {}
    write(data: string): boolean {
      const frame = JSON.parse(data.trim()) as {
        id: string;
        params: { method: string; input: Record<string, unknown> };
      };
      dispatched.push(frame.params);
      queueMicrotask(() =>
        this.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ id: frame.id, ok: true, result: { action_sent: true } })}\n`,
          ),
        ),
      );
      return true;
    }
  }
  const runtime = createNativeBrowserCuaMcpRuntime({
    endpoint: "/fixture/native-browser.sock",
    tokenFile: "/fixture/native-browser.token",
    cuaBroker: { socketPath: "/fixture/cua.sock", capability: "fixture-authority", generation: 0 },
    readFile: async () => "fixture-token",
    connect: () => {
      const socket = new FixtureSocket();
      queueMicrotask(() => socket.emit("connect"));
      return socket as unknown as Socket;
    },
  });
  const client = new Client({ name: "cua-target-fixture", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((entry) => entry.name === "cua_command");
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema, nativeBrowserCuaMcpCuaCommandJsonSchema);
    assert.match(tool.description ?? "", /"target":7/);
    assert.match(tool.description ?? "", /"target":\[40,60\]/);
    for (const target of [7, [40, 60]]) {
      for (const method of [
        "left_click",
        "left_click_drag",
        "scroll",
        "set_value",
        "select_text",
        "perform_action",
        "type",
      ]) {
        const input: Record<string, unknown> = { app_ref: { name: "Fixture" } };
        if (method === "left_click_drag") Object.assign(input, { from_target: target, to: target });
        else input.target = target;
        if (method === "scroll")
          Object.assign(input, { scroll_direction: "down", scroll_amount: 1 });
        if (method === "set_value") input.value = "fixture";
        if (method === "perform_action") input.action = "press";
        if (method === "type") input.text = "fixture";
        const result = await client.callTool({
          name: "cua_command",
          arguments: { method, ...input },
        });
        assert.notEqual(result.isError, true);
        assert.equal(dispatched.at(-1)?.method, method);
        assert.deepEqual(dispatched.at(-1)?.input, input);
      }
    }
    const observationInput = {
      app_ref: { name: "Fixture" },
      include_screenshot: true,
      disable_diffing: true,
      tree_shown_to_model: true,
    };
    await client.callTool({
      name: "cua_command",
      arguments: { method: "get_app_state", ...observationInput },
    });
    assert.deepEqual(dispatched.at(-1)?.input, observationInput);
    for (const method of ["type", "paste"]) {
      const result = await client.callTool({
        name: "cua_command",
        arguments: { method, text: "" },
      });
      assert.notEqual(result.isError, true);
      assert.equal(dispatched.at(-1)?.input.text, "");
    }
    const beforeInvalid = dispatched.length;
    for (const target of ["7", "[40,60]"]) {
      await assert.rejects(
        client.callTool({ name: "cua_command", arguments: { method: "left_click", target } }),
        /target: Invalid input/,
      );
    }
    await assert.rejects(
      client.callTool({ name: "cua_command", arguments: { method: "key", text: "" } }),
      /text:/,
    );
    assert.equal(dispatched.length, beforeInvalid);
  } finally {
    await Promise.allSettled([client.close(), runtime.server.close()]);
    runtime.dispose();
  }
});
