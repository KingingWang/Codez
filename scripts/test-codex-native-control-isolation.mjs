import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { buildCodexBridge } from "./build-codex-bridge.mjs";
import { stageCodexBinary } from "./codex-runtime.mjs";
import { createNativeCuaModelServer } from "./codex-native-cua-smoke-fixture.mjs";

const MCP_WRAPPER = "mcp__codez_desktop_browser_cua";
const BROWSER_FLAG = "CODEZ_NATIVE_BROWSER_CUA_BROWSER_AVAILABLE";
const CUA_FLAG = "CODEZ_NATIVE_BROWSER_CUA_CUA_ENABLED";

let readiness;
const prepareRuntime = () => {
  readiness ??= Promise.all([stageCodexBinary(), buildCodexBridge()]);
  return readiness;
};

let nextEndpointSequence = 0;

function endpointPath(directory, name) {
  const sequence = (nextEndpointSequence += 1);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\codez-native-control-isolation-${process.pid}-${name}-${sequence}`
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

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

function createBrowserBroker() {
  let connections = 0;
  const server = createSocketServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  return {
    async connectionCount() {
      return connections;
    },
    server,
  };
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
      const result = {
        content: [{ type: "text", text: "synthetic-list-apps-result" }],
      };
      socket.end(`${JSON.stringify({ id: frame.id, ok: true, result })}\n`);
      buffer = "";
    });
  });
  return { frames, server };
}

function modelVisibleTools(request) {
  const wrapper = (request.tools ?? []).find((tool) => tool.name === MCP_WRAPPER);
  if (wrapper) return wrapper.tools.map((tool) => tool.name);
  return (request.tools ?? [])
    .filter((tool) => tool.name?.startsWith(MCP_WRAPPER))
    .map((tool) => tool.name);
}

function rejectOnAbort(signal, label) {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason ?? new Error(`${label} was aborted`));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error(`${label} was aborted`)),
      { once: true },
    );
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  closed.catch(() => {});
  child.stdin?.end();
  child.kill();
  await closed;
}

async function runScenario({ browserEnabled, cuaEnabled, signal }) {
  return runScenarioWithOptions({ browserEnabled, cuaEnabled, signal });
}

async function runScenarioWithOptions({ browserEnabled, cuaEnabled, signal, lateGrant = false }) {
  const temporary = await mkdtemp(join(tmpdir(), "codex-native-control-isolation-"));
  const codexHome = join(temporary, "codex-home");
  const workspace = join(temporary, "workspace");
  await mkdir(codexHome);
  await mkdir(workspace);
  const modelRequests = [];
  let grantPublished = false;
  const browserEndpoint = endpointPath(temporary, "browser");
  const cuaEndpoint = endpointPath(temporary, "cua");
  const staleCuaEndpoint = endpointPath(temporary, "stale-cua");
  const grantFile = join(temporary, "late-cua-grant.json");
  let lateGrantTimer;
  let lateGrantWriteError;
  const model = createNativeCuaModelServer(
    (request) => {
      modelRequests.push(request);
      if (!lateGrant || modelRequests.length > 1) return;
      lateGrantTimer = setTimeout(() => {
        lateGrantTimer = undefined;
        const temporaryGrantFile = `${grantFile}.${process.pid}.tmp`;
        const grant = `${JSON.stringify({
          socketPath: cuaEndpoint,
          capability: "late-grant-authority",
          generation: 21,
        })}\n`;
        writeFile(temporaryGrantFile, grant, { mode: 0o600 })
          .then(() => rename(temporaryGrantFile, grantFile))
          .then(() => {
            grantPublished = true;
          })
          .catch((error) => {
            lateGrantWriteError = error;
          });
      }, 150);
      lateGrantTimer.unref?.();
    },
    MCP_WRAPPER,
    cuaEnabled ? [{ name: "cua_command", arguments: { method: "list_apps" } }] : [],
  );
  let browserBroker;
  let cuaBroker;
  let child;
  let lines;
  const pending = new Map();
  let completionTimer;
  let aborted;
  try {
    aborted = rejectOnAbort(signal, "native control isolation smoke");
    await new Promise((resolve, reject) => {
      model.once("error", reject);
      model.listen(0, "127.0.0.1", () => {
        model.off("error", reject);
        resolve();
      });
    });
    if (browserEnabled) {
      browserBroker = createBrowserBroker();
      await listen(browserBroker.server, browserEndpoint);
    }
    if (cuaEnabled) {
      cuaBroker = createCuaBroker();
      await listen(cuaBroker.server, cuaEndpoint);
    }
    const tokenFile = join(temporary, "browser.token");
    await writeFile(tokenFile, "synthetic-browser-token\n", { mode: 0o600 });
    await writeFile(
      join(codexHome, "config.toml"),
      `model_provider = "smoke"\nmodel = "native-control-isolation-smoke"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[model_providers.smoke]\nname = "Isolated native control smoke"\nbase_url = "http://127.0.0.1:${model.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n`,
    );
    const [binary, bridge] = await prepareRuntime();
    const mcpEnvironment = {
      ELECTRON_RUN_AS_NODE: "1",
      CODEZ_NATIVE_BROWSER_CUA_ENDPOINT: browserEndpoint,
      CODEZ_NATIVE_BROWSER_CUA_TOKEN_FILE: tokenFile,
      [BROWSER_FLAG]: browserEnabled ? "1" : "0",
      [CUA_FLAG]: cuaEnabled ? "1" : "0",
      // 旧键故意相反：本 smoke 锁定 Desktop 新注入的独立 CUA enablement 契约。
      CODEZ_NATIVE_BROWSER_CUA_CUA_AVAILABLE: cuaEnabled ? "0" : "1",
      CODEZ_CUA_PERMISSION_BROKER_SOCKET: lateGrant ? staleCuaEndpoint : cuaEndpoint,
      CODEZ_CUA_PLUGIN_AUTHORITY: lateGrant ? "stale-cua-authority" : "synthetic-cua-authority",
      CODEZ_CUA_PERMISSION_BROKER_GENERATION: lateGrant ? "7" : "11",
    };
    if (lateGrant) mcpEnvironment.CODEZ_CUA_BROKER_GRANT_FILE = grantFile;
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
      signal,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
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
    const rpc = (method, params) =>
      Promise.race([
        new Promise((resolve, reject) => {
          const id = ++nextId;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Codex RPC timed out: ${method}; stderr:\n${stderr}`));
          }, 30000);
          timer.unref();
          pending.set(id, { resolve, reject, timer });
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        }),
        aborted,
      ]);
    lines = createInterface({ input: child.stdout });
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
    await rpc("initialize", {
      clientInfo: { name: "codez_native_control_isolation_smoke", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const started = await rpc("thread/start", {
      cwd: workspace,
      historyMode: "paginated",
      model: "native-control-isolation-smoke",
      modelProvider: "smoke",
    });
    await rpc("turn/start", {
      threadId: started.thread.id,
      input: [
        {
          type: "text",
          text: "List the model-visible native control tools.",
          text_elements: [],
        },
      ],
    });
    await Promise.race([completed, aborted]);
    return {
      browserConnections: browserEnabled ? await browserBroker.connectionCount() : 0,
      cuaFrames: cuaBroker?.frames ?? [],
      modelRequests,
      browserEndpoint,
      cuaEndpoint,
      staleCuaEndpoint,
      lateGrantWriteError,
      lateGrantPublished: grantPublished,
    };
  } finally {
    if (lateGrantTimer) clearTimeout(lateGrantTimer);
    clearTimeout(completionTimer);
    lines?.close();
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    await stopChild(child).catch(() => {});
    await closeServer(model);
    await closeServer(browserBroker?.server);
    await closeServer(cuaBroker?.server);
    // macOS arm64 偶发仍有插件 Git 进程释放文件句柄，递归删除需按 Node 的重试策略等待目录稳定。
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function assertScenario({ browserEnabled, cuaEnabled, expectedTools, signal }) {
  const scenario = await runScenario({ browserEnabled, cuaEnabled, signal });
  assert.ok(
    scenario.modelRequests.length > 0,
    "Codex must send at least one request to the isolated fake model",
  );
  for (const request of scenario.modelRequests) {
    assert.deepEqual(
      modelVisibleTools(request).sort(),
      expectedTools,
      "model-visible native control declarations must match the independent switches",
    );
  }
  if (browserEnabled) {
    assert.ok(
      scenario.browserConnections > 0,
      "browser declarations must retain their real Desktop broker reachability preflight",
    );
  } else {
    assert.equal(
      scenario.browserConnections,
      0,
      "disabled browser declarations must not depend on a browser broker",
    );
  }
  if (cuaEnabled) {
    assert.equal(
      scenario.modelRequests.length,
      2,
      "CUA-only list_apps must complete one tool round trip",
    );
    assert.deepEqual(
      scenario.modelRequests[1]?.input?.find((item) => item.type === "function_call")?.arguments,
      JSON.stringify({ method: "list_apps" }),
    );
    assert.deepEqual(
      scenario.cuaFrames.map((frame) => ({ method: frame.method, input: frame.params.input })),
      [{ method: "execute", input: {} }],
    );
    assert.ok(
      scenario.modelRequests
        .slice(1)
        .flatMap((request) => request.input ?? [])
        .some(
          (item) =>
            item.type === "function_call_output" &&
            JSON.stringify(item).includes("synthetic-list-apps-result"),
        ),
    );
  }
  return scenario;
}

test(
  "same MCP keeps CUA tools declared before a late grant and recovers with the granted broker",
  { timeout: 120000 },
  async ({ signal }) => {
    const scenario = await runScenarioWithOptions({
      browserEnabled: false,
      cuaEnabled: true,
      signal,
      lateGrant: true,
    });
    assert.ok(
      scenario.modelRequests.length > 0,
      "Codex must declare CUA tools before the grant file exists",
    );
    for (const request of scenario.modelRequests) {
      assert.deepEqual(
        modelVisibleTools(request).sort(),
        ["cua_command", "cua_status"],
        "missing grant must not remove model-visible CUA declarations",
      );
    }
    assert.equal(scenario.modelRequests.length, 2, "late grant must recover the same CUA call");
    assert.deepEqual(
      scenario.modelRequests[1]?.input?.find((item) => item.type === "function_call")?.arguments,
      JSON.stringify({ method: "list_apps" }),
    );
    assert.equal(scenario.lateGrantWriteError, undefined);
    assert.equal(scenario.lateGrantPublished, true);
    assert.equal(
      scenario.cuaFrames.length,
      1,
      JSON.stringify(scenario.modelRequests[1]?.input ?? []),
    );
    assert.equal(scenario.cuaFrames[0].capability, "late-grant-authority");
    assert.equal(scenario.cuaFrames[0].generation, 21);
    assert.notEqual(scenario.cuaFrames[0].capability, "stale-cua-authority");
    assert.ok(
      scenario.modelRequests
        .slice(1)
        .flatMap((request) => request.input ?? [])
        .some(
          (item) =>
            item.type === "function_call_output" &&
            JSON.stringify(item).includes("synthetic-list-apps-result"),
        ),
      "the original MCP call must succeed through the late-granted real broker",
    );
  },
);

test(
  "model sees no native control tools when browser and CUA are disabled",
  { timeout: 120000 },
  async ({ signal }) => {
    await assertScenario({
      browserEnabled: false,
      cuaEnabled: false,
      expectedTools: [],
      signal,
    });
  },
);

test(
  "model sees only browser_command when browser is enabled and CUA is disabled",
  { timeout: 120000 },
  async ({ signal }) => {
    await assertScenario({
      browserEnabled: true,
      cuaEnabled: false,
      expectedTools: ["browser_command"],
      signal,
    });
  },
);

test(
  "model sees only CUA tools and dispatches list_apps without a browser broker",
  { timeout: 120000 },
  async ({ signal }) => {
    await assertScenario({
      browserEnabled: false,
      cuaEnabled: true,
      expectedTools: ["cua_command", "cua_status"],
      signal,
    });
  },
);

test(
  "model sees browser and CUA tools together when both switches are enabled",
  { timeout: 120000 },
  async ({ signal }) => {
    await assertScenario({
      browserEnabled: true,
      cuaEnabled: true,
      expectedTools: ["browser_command", "cua_command", "cua_status"],
      signal,
    });
  },
);
