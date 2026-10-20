import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { buildCodexBridge } from "./build-codex-bridge.mjs";
import { stageCodexBinary } from "./codex-runtime.mjs";
import { createNativeCuaModelServer } from "./codex-native-cua-smoke-fixture.mjs";

const CUA_METHODS = [
  "list_apps",
  "list_windows",
  "get_app_state",
  "left_click",
  "left_click_drag",
  "scroll",
  "type",
  "set_value",
  "select_text",
  "key",
  "paste",
  "perform_action",
  "request_access",
  "stop_computer_control",
];
const MCP_WRAPPER = "mcp__codez_desktop_browser_cua";
const CUA_FIELDS = [
  "method",
  "app_ref",
  "include_screenshot",
  "disable_diffing",
  "tree_shown_to_model",
  "target",
  "from_target",
  "to",
  "mouse_button",
  "click_count",
  "modifiers",
  "strategy",
  "return_state",
  "scroll_direction",
  "scroll_amount",
  "text",
  "value",
  "text_range",
  "repeat",
  "hold_seconds",
  "format",
  "action",
  "capabilities",
  "reason",
];

function endpointPath(directory, name) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\codez-native-cua-smoke-${process.pid}-${name}`
    : join(directory, `${name}.sock`);
}

async function listen(server, endpoint) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function createCuaBroker() {
  const frames = [];
  const server = createSocketServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(buffer.slice(0, newline));
      frames.push(frame);
      const marker = frame.params.input?.target;
      const result =
        frame.method === "permission_status"
          ? { platform: process.platform, accessibility: { state: "granted" } }
          : {
              content: [
                {
                  type: "text",
                  text: Array.isArray(marker) ? "array-target-result" : "numeric-target-result",
                },
              ],
            };
      socket.end(`${JSON.stringify({ id: frame.id, ok: true, result })}\n`);
      buffer = "";
    });
  });
  return { server, frames };
}

function expectedTargetSchema(value) {
  assert.equal(value.type, undefined);
  assert.ok(Array.isArray(value.anyOf), "target must retain its explicit union");
  assert.equal(value.anyOf.length, 4);
  assert.deepEqual(
    value.anyOf.map((branch) => branch.type),
    ["integer", "array", "object", "object"],
  );
  assert.equal(value.anyOf[1].type, "array");
  assert.equal(value.anyOf[1].minItems, 2);
  assert.equal(
    value.anyOf[2].properties?.type?.const ?? value.anyOf[2].properties?.type?.enum?.[0],
    "element",
  );
  assert.equal(value.anyOf[2].properties?.index?.type, "integer");
  assert.equal(
    value.anyOf[3].properties?.type?.const ?? value.anyOf[3].properties?.type?.enum?.[0],
    "coordinate",
  );
  assert.equal(value.anyOf[3].properties?.x?.type, "integer");
  assert.equal(value.anyOf[3].properties?.y?.type, "integer");
  assert.equal(value.anyOf[3].properties?.frame_id?.type, "string");
}

test(
  "pinned Codex sends native CUA declarations and preserves JSON target types",
  { timeout: 120000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "codex-native-cua-smoke-"));
    const codexHome = join(temporary, "codex-home");
    const workspace = join(temporary, "workspace");
    await mkdir(codexHome);
    await mkdir(workspace);
    const modelRequests = [];
    const model = createNativeCuaModelServer(
      (request) => modelRequests.push(request),
      MCP_WRAPPER,
      [
        { name: "cua_command", arguments: { method: "left_click", target: 7 } },
        { name: "cua_command", arguments: { method: "left_click", target: [40, 60] } },
      ],
    );
    let browserBrokerServer;
    let cuaBroker;
    let child;
    let modelAddress;
    let completionTimer;
    try {
      await new Promise((resolve, reject) => {
        model.once("error", reject);
        model.listen(0, "127.0.0.1", () => {
          model.off("error", reject);
          resolve();
        });
      });
      modelAddress = model.address();
      const browserEndpoint = endpointPath(temporary, "browser");
      const cuaEndpoint = endpointPath(temporary, "cua");
      browserBrokerServer = createSocketServer((socket) => socket.destroy());
      cuaBroker = createCuaBroker();
      await listen(browserBrokerServer, browserEndpoint);
      await listen(cuaBroker.server, cuaEndpoint);
      const tokenFile = join(temporary, "browser.token");
      await writeFile(tokenFile, "synthetic-browser-token\n", { mode: 0o600 });
      await writeFile(
        join(codexHome, "config.toml"),
        `model_provider = "smoke"\nmodel = "native-cua-smoke"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[model_providers.smoke]\nname = "Isolated native CUA smoke"\nbase_url = "http://127.0.0.1:${modelAddress.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n`,
      );
      const binary = await stageCodexBinary();
      const bridge = await buildCodexBridge();
      const mcpEnvironment = {
        ELECTRON_RUN_AS_NODE: "1",
        CODEZ_NATIVE_BROWSER_CUA_ENDPOINT: browserEndpoint,
        CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: tokenFile,
        CODEZ_NATIVE_BROWSER_CUA_BROWSER_AVAILABLE: "1",
        CODEZ_NATIVE_BROWSER_CUA_CUA_AVAILABLE: "1",
        CODEZ_CUA_PERMISSION_BROKER_SOCKET: cuaEndpoint,
        CODEZ_CUA_PLUGIN_AUTHORITY: "synthetic-cua-authority",
        CODEZ_CUA_PERMISSION_BROKER_GENERATION: "9",
      };
      const registration = `mcp_servers.codez-desktop-browser-cua={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([bridge, "native-browser-cua-mcp"])},env={${Object.entries(
        mcpEnvironment,
      )
        .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
        .join(",")}},enabled=true,required=true}`;
      const env = { CODEX_HOME: codexHome };
      for (const key of [
        "PATH",
        "Path",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
      ]) {
        if (process.env[key]) env[key] = process.env[key];
      }
      child = spawn(binary, ["app-server", "--listen", "stdio://", "-c", registration], {
        cwd: workspace,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const closed = once(child, "close");
      closed.catch(() => {});
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-8192);
      });
      const pending = new Map();
      let nextId = 0;
      let turnCompleted;
      const completed = new Promise((resolve, reject) => {
        turnCompleted = resolve;
        completionTimer = setTimeout(
          () => reject(new Error(`Codex turn timed out; stderr:\n${stderr}`)),
          90000,
        );
        completionTimer.unref();
      });
      completed.catch(() => {});
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        const value = JSON.parse(line);
        if (value.method === "turn/completed" && value.params?.turn?.status === "completed") {
          turnCompleted();
        }
        const entry = pending.get(value.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(value.id);
        if (value.error) entry.reject(new Error(JSON.stringify(value.error)));
        else entry.resolve(value.result);
      });
      const rpc = (method, params) =>
        new Promise((resolve, reject) => {
          const id = ++nextId;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Codex RPC timed out: ${method}; stderr:\n${stderr}`));
          }, 30000);
          pending.set(id, { resolve, reject, timer });
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        });
      await rpc("initialize", {
        clientInfo: { name: "codez_native_cua_smoke", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      const started = await rpc("thread/start", {
        cwd: workspace,
        historyMode: "paginated",
        model: "native-cua-smoke",
        modelProvider: "smoke",
      });
      await rpc("turn/start", {
        threadId: started.thread.id,
        input: [
          { type: "text", text: "Exercise synthetic native CUA targets.", text_elements: [] },
        ],
      });
      await completed;

      assert.equal(
        modelRequests.length,
        3,
        `expected three model round trips, got ${modelRequests.length}`,
      );
      const tools = modelRequests.flatMap((request) => request.tools ?? []);
      const wrapper = tools.find((tool) => tool.name === MCP_WRAPPER);
      assert.ok(wrapper, "Codex must register the native Browser/CUA MCP server with the model");
      assert.deepEqual(wrapper.tools.map((tool) => tool.name).sort(), [
        "browser_command",
        "cua_command",
        "cua_status",
      ]);
      const browser = wrapper.tools.find((tool) => tool.name === "browser_command");
      const cua = wrapper.tools.find((tool) => tool.name === "cua_command");
      assert.ok(
        browser && cua,
        "Browser and CUA must remain independent declarations inside the namespace",
      );
      assert.equal(
        tools.filter((tool) => tool.name?.startsWith(MCP_WRAPPER)).length,
        modelRequests.length,
      );
      assert.deepEqual(cua.parameters.properties.method.enum, CUA_METHODS);
      assert.deepEqual(Object.keys(cua.parameters.properties).sort(), [...CUA_FIELDS].sort());
      assert.deepEqual(cua.parameters.required, ["method"]);
      assert.equal(cua.parameters.additionalProperties, false);
      assert.equal(cua.parameters.properties.modifiers.type, "string");
      assert.equal(cua.parameters.properties.method.enum.includes("navigate"), false);
      assert.match(cua.description, /"target":7/);
      assert.match(cua.description, /"target":\[40,60\]/);
      for (const field of ["target", "from_target", "to"])
        expectedTargetSchema(cua.parameters.properties[field]);
      for (const field of [
        "include_screenshot",
        "strategy",
        "return_state",
        "modifiers",
        "app_ref",
        "action",
        "text_range",
      ]) {
        assert.ok(cua.parameters.properties[field], `CUA schema dropped ${field}`);
      }
      assert.equal(browser.parameters.properties.method.enum.includes("left_click"), false);
      assert.equal(browser.parameters.properties.target, undefined);
      assert.equal(browser.parameters.properties.modifiers.type, "array");

      assert.equal(cuaBroker.frames.length, 2);
      const executeFrames = cuaBroker.frames.filter((frame) => frame.method === "execute");
      assert.equal(executeFrames.length, 2);
      assert.deepEqual(
        executeFrames.map((frame) => frame.params.input.target),
        [7, [40, 60]],
      );
      for (const frame of executeFrames) {
        assert.equal(
          typeof frame.params.input.target,
          frame.params.input.target === 7 ? "number" : "object",
        );
        assert.equal(frame.capability, "synthetic-cua-authority");
        assert.equal(frame.generation, 9);
        assert.deepEqual(frame.params.context, {
          workspaceKey: "native-browser-cua:local",
          sessionId: "codex-native-browser-cua",
          runtimeScope: "main",
        });
      }
      const followUps = modelRequests.slice(1).flatMap((request) => request.input ?? []);
      assert.ok(
        followUps.some(
          (item) =>
            item.type === "function_call_output" &&
            JSON.stringify(item).includes("numeric-target-result"),
        ),
      );
      assert.ok(
        followUps.some(
          (item) =>
            item.type === "function_call_output" &&
            JSON.stringify(item).includes("array-target-result"),
        ),
      );
    } finally {
      clearTimeout(completionTimer);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.stdin?.end();
        const stopped = once(child, "close").catch(() => {});
        child.kill();
        await stopped;
      }
      await new Promise((resolve) => model.close(() => resolve()));
      await new Promise((resolve) => browserBrokerServer?.close(() => resolve()) ?? resolve());
      await new Promise((resolve) => cuaBroker?.server.close(() => resolve()) ?? resolve());
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
