import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodexProcess } from "../src/codex-process.js";
import { buildZip, zipSha256 } from "./helpers/zip-fixture.js";
// @ts-expect-error Test-only JavaScript runtime helpers are outside this package's typed API.
import { buildCodexBridge } from "../../../scripts/build-codex-bridge.mjs";
// @ts-expect-error Test-only JavaScript runtime helpers are outside this package's typed API.
import { stageCodexBinary } from "../../../scripts/codex-runtime.mjs";

const SERVER_NAME = "native-probe-mcp";
const PLUGIN_NAME = "native-probe";
const MARKETPLACE = "codez-plugins-official";

const mcpScript = `
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const outgoing = [];
lines.on("line", (line) => {
  const task = (async () => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: {}, serverInfo: { name: "native-probe", version: "1.0.0" } } });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "report", description: "report isolated runtime environment", inputSchema: { type: "object", properties: { scenario: { type: "string" } }, required: ["scenario"], additionalProperties: false } },
      { name: "block", description: "block until the configured tool timeout", inputSchema: { type: "object", additionalProperties: false } },
    ] } });
    return;
  }
  if (message.method === "tools/call") {
    const tool = message.params?.name;
    if (tool === "block") {
      setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { content: [], isError: true } }), 8_000);
      return;
    }
    if (tool === "report") {
      const value = {
        scenario: message.params?.arguments?.scenario,
        cwd: process.cwd(),
        env: {
          ZCODE_PROJECT_DIR: process.env.ZCODE_PROJECT_DIR,
          CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
          ZCODE_WORKSPACE_ROOT: process.env.ZCODE_WORKSPACE_ROOT,
          ZCODE_WORKSPACE_IDENTITY: process.env.ZCODE_WORKSPACE_IDENTITY,
          ZCODE_PLUGIN_DATA: process.env.ZCODE_PLUGIN_DATA,
          CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
        },
      };
      const root = process.env.CLAUDE_PLUGIN_DATA;
      if (root) {
        await mkdir(root, { recursive: true });
        await writeFile(join(root, "mcp-report.json"), JSON.stringify(value) + "\\n");
      }
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
      return;
    }
  }
  })();
  outgoing.push(task);
  task.catch(() => {});
});
`;

const hookScript = `
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const mode = process.argv[2];
const projectArgument = process.argv[3];
const root = process.env.CLAUDE_PLUGIN_DATA;
if (!root || !mode) throw new Error("native hook fixture inputs missing");
await mkdir(join(root, "hooks"), { recursive: true });
await writeFile(join(root, "hooks", mode + ".json"), JSON.stringify({ cwd: process.cwd(), projectArgument, pluginData: root }) + "\\n");
`;

const unsafeScript = `
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const root = process.env.CLAUDE_PLUGIN_DATA;
if (root) await writeFile(join(root, "unsafe-ran.json"), JSON.stringify({ cwd: process.cwd() }) + "\\n");
`;

function childEnv(codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
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
  return env;
}

function sseResponse(text: string): string {
  const item = {
    type: "message",
    id: "item-native",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const completed = {
    id: "resp-native",
    object: "response",
    status: "completed",
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const events = [
    { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

async function startBridge(options: {
  cwd: string;
  identity: string;
  codexHome: string;
  bridgeHome: string;
  catalog: string;
  artifact: string;
  bridge: string;
  wrapper: string;
}) {
  const env: NodeJS.ProcessEnv = {
    ...childEnv(options.codexHome),
    CODEZ_CODEX_COMMAND: await stageCodexBinary(),
    CODEZ_CODEX_BRIDGE_HOME: options.bridgeHome,
    CODEZ_WORKSPACE_IDENTITY: options.identity,
    CODEZ_OFFICIAL_NATIVE_TEST_CATALOG: options.catalog,
    CODEZ_OFFICIAL_NATIVE_TEST_ARTIFACT: options.artifact,
    CODEZ_OFFICIAL_NATIVE_TEST_BRIDGE: options.bridge,
  };
  const child = spawn(process.execPath, [options.wrapper], {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  closed.catch(() => undefined);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  let nextId = 0;
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      const entry = pending.get(value.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      pending.delete(value.id);
      if (value.error) entry.reject(new Error(JSON.stringify(value.error)));
      else entry.resolve(value.result);
    }
  });
  child.on("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Bridge exited: ${stderr}`));
    }
    pending.clear();
  });
  const rpc = <T = unknown>(method: string, params?: unknown) =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Bridge RPC timed out: ${method}; ${stderr}`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  return {
    rpc,
    stderr: () => stderr,
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      const [code, signal] = (await closed) as [number | null, NodeJS.Signals | null];
      assert.equal(code, 0, `Bridge exited signal=${signal ?? "none"}; ${stderr}`);
    },
  };
}

async function waitFile(path: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || Date.now() >= deadline)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function runScenario(options: {
  label: string;
  cwd: string;
  identity: string;
  codexHome: string;
  binary: string;
  port: number;
  dataRoot: string;
}) {
  const rpc = createCodexProcess({
    executable: options.binary,
    cwd: options.cwd,
    workspaceIdentity: options.identity,
    env: childEnv(options.codexHome),
    requestTimeoutMs: 20_000,
  });
  const hookEvents: unknown[] = [];
  const unsubscribeHookEvents = rpc.onNotification((event) => {
    if (event.method === "hook/started" || event.method === "hook/completed")
      hookEvents.push(event);
  });
  try {
    await rpc.initialize();
    const started = await rpc.request<{ thread: { id: string } }>("thread/start", {
      cwd: options.cwd,
      historyMode: "paginated",
      model: "official-plugin-native-model",
      modelProvider: "official-plugin-native",
      threadSource: "codez_project:official-plugin-native",
    });
    const threadId = started.thread.id;
    const status = await rpc.request<{
      data: Array<{ name: string; tools: Record<string, unknown>; toolsError: string | null }>;
    }>("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly", serverName: SERVER_NAME });
    const server = status.data.find((entry) => entry.name === SERVER_NAME);
    assert.ok(server, `missing ${SERVER_NAME} in ${options.label}`);
    assert.equal(server.toolsError, null);
    assert.ok(Object.keys(server.tools).includes("report"), JSON.stringify(server.tools));

    const call = await rpc.request<{ content: Array<{ text?: string }>; isError?: boolean }>(
      "mcpServer/tool/call",
      { threadId, server: SERVER_NAME, tool: "report", arguments: { scenario: options.label } },
    );
    assert.equal(call.isError, undefined);
    const reported = JSON.parse(call.content[0]?.text ?? "{}") as {
      scenario: string;
      cwd: string;
      env: Record<string, string>;
    };
    assert.equal(reported.scenario, options.label);
    assert.equal(reported.cwd, options.cwd);
    assert.equal(reported.env.ZCODE_PROJECT_DIR, options.cwd);
    assert.equal(reported.env.CLAUDE_PROJECT_DIR, options.cwd);
    assert.equal(reported.env.ZCODE_WORKSPACE_ROOT, options.cwd);
    assert.equal(reported.env.ZCODE_WORKSPACE_IDENTITY, options.identity);
    assert.equal(reported.env.ZCODE_PLUGIN_DATA, options.dataRoot);
    assert.equal(reported.env.CLAUDE_PLUGIN_DATA, options.dataRoot);

    let completed!: () => void;
    const turnCompleted = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const unsubscribe = rpc.onNotification((event) => {
      if (event.method !== "turn/completed") return;
      const params = event.params as { threadId?: string; turn?: { status?: string } };
      if (params.threadId === threadId && params.turn?.status === "completed") completed();
    });
    try {
      await rpc.request("turn/start", {
        threadId,
        input: [
          { type: "text", text: `Run native probe hooks for ${options.label}`, text_elements: [] },
        ],
      });
      await Promise.race([
        turnCompleted,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`turn timed out: ${options.label}`)), 20_000),
        ),
      ]);
    } finally {
      unsubscribe();
    }
    for (const event of ["session-start", "user-prompt-submit"]) {
      try {
        const value = JSON.parse(await waitFile(join(options.dataRoot, "hooks", `${event}.json`)));
        assert.equal(value.cwd, options.cwd);
        assert.equal(value.projectArgument, ".");
        assert.equal(value.pluginData, options.dataRoot);
      } catch (error) {
        throw new Error(
          `Native hook output missing in ${options.label}: ${JSON.stringify(hookEvents)}`,
          { cause: error },
        );
      }
    }
  } finally {
    unsubscribeHookEvents();
    await rpc.close();
  }
}

async function assertNativeToolTimeout(options: {
  cwd: string;
  identity: string;
  codexHome: string;
  binary: string;
  port: number;
}): Promise<void> {
  const rpc = createCodexProcess({
    executable: options.binary,
    cwd: options.cwd,
    workspaceIdentity: options.identity,
    env: childEnv(options.codexHome),
    requestTimeoutMs: 20_000,
  });
  try {
    await rpc.initialize();
    const started = await rpc.request<{ thread: { id: string } }>("thread/start", {
      cwd: options.cwd,
      historyMode: "paginated",
      model: "official-plugin-native-model",
      modelProvider: "official-plugin-native",
      threadSource: "codez_project:official-plugin-native-timeout",
    });
    const startedAt = Date.now();
    await assert.rejects(
      rpc.request("mcpServer/tool/call", {
        threadId: started.thread.id,
        server: SERVER_NAME,
        tool: "block",
        arguments: {},
      }),
      /timed? ?out|timeout/iu,
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed > 0 && elapsed < 5_000,
      `tool timeout did not use the configured short timeout: ${elapsed}ms`,
    );
  } finally {
    await rpc.close();
  }
}

test(
  "pinned official plugin native MCP and hooks preserve workspace/data scope through the real bridge install",
  { timeout: 180_000 },
  async (t) => {
    // macOS 的 /var 与 /private/var 是同一目录；后续断言统一使用真实物理路径。
    const root = await realpath(await mkdtemp(join(tmpdir(), "official-plugin-native-")));
    const codexHome = join(root, "codex-home");
    const bridgeHome = join(root, "bridge-home");
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const dataRoot = join(codexHome, "plugins", "data", `${PLUGIN_NAME}-${MARKETPLACE}`);
    await mkdir(codexHome, { recursive: true });
    await mkdir(bridgeHome, { recursive: true });
    await mkdir(workspaceA, { recursive: true });
    await mkdir(workspaceB, { recursive: true });
    await writeFile(join(workspaceA, "unsafe-native-probe.mjs"), unsafeScript);
    await writeFile(join(workspaceB, "unsafe-native-probe.mjs"), unsafeScript);
    t.after(async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    const fixtureScript = join(root, "official-plugin-native-scripts.mjs");
    await writeFile(fixtureScript, mcpScript);
    const fixtureSyntax = spawnSync(process.execPath, ["--check", fixtureScript], {
      encoding: "utf8",
    });
    assert.equal(fixtureSyntax.status, 0, `MCP fixture syntax failed: ${fixtureSyntax.stderr}`);
    const hookFixture = join(root, "official-plugin-native-hook.mjs");
    await writeFile(hookFixture, hookScript);
    const entries = [
      {
        name: `${PLUGIN_NAME}/.claude-plugin/plugin.json`,
        content: `${JSON.stringify({ name: PLUGIN_NAME, version: "1.0.0" }, null, 2)}\n`,
      },
      { name: `${PLUGIN_NAME}/scripts/native.mjs`, content: mcpScript },
      { name: `${PLUGIN_NAME}/scripts/hook.mjs`, content: hookScript },
      {
        name: `${PLUGIN_NAME}/hooks/hooks.json`,
        content: `${JSON.stringify(
          {
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    {
                      type: "process",
                      command: process.execPath,
                      args: [hookFixture, "session-start", "${ZCODE_PROJECT_DIR}"],
                    },
                  ],
                },
              ],
              UserPromptSubmit: [
                {
                  hooks: [
                    {
                      type: "process",
                      command: process.execPath,
                      args: [hookFixture, "user-prompt-submit", "${ZCODE_PROJECT_DIR}"],
                    },
                  ],
                },
              ],
              Stop: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: `node ${hookFixture} unsafe >${"${ZCODE_PROJECT_DIR}"}/unsafe-ran.json`,
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        )}\n`,
      },
      {
        name: `${PLUGIN_NAME}/.mcp.json`,
        content: `${JSON.stringify(
          {
            mcpServers: {
              [SERVER_NAME]: {
                type: "stdio",
                command: process.execPath,
                args: [fixtureScript],
                env: {
                  ZCODE_PROJECT_DIR: "${ZCODE_PROJECT_DIR}",
                  CLAUDE_PROJECT_DIR: "${CLAUDE_PROJECT_DIR}",
                  ZCODE_WORKSPACE_ROOT: "${ZCODE_PROJECT_DIR}",
                },
                timeoutMs: 1200,
              },
            },
          },
          null,
          2,
        )}\n`,
      },
    ];
    const artifact = buildZip(entries);
    const artifactPath = join(root, "plugin.zip");
    const catalogPath = join(root, "marketplace.json");
    await writeFile(artifactPath, artifact);
    await writeFile(
      catalogPath,
      `${JSON.stringify(
        {
          name: "zcode-plugins-official",
          plugins: [
            {
              name: PLUGIN_NAME,
              version: "1.0.0",
              source: {
                source: "url",
                type: "zip",
                url: "https://cdn-zcode.z.ai/zcode/official-plugin/plugins/native-probe/1.0.0/plugin.zip",
                sha256: zipSha256(artifact),
                path: PLUGIN_NAME,
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const model = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.once("end", () => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.end(sseResponse("official plugin native hooks complete"));
      });
    });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    t.after(() => {
      model.closeAllConnections();
      return new Promise<void>((resolve, reject) =>
        model.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = model.address();
    assert.ok(address && typeof address !== "string");
    await writeFile(
      join(codexHome, "config.toml"),
      [
        'model_provider = "official-plugin-native"',
        'model = "official-plugin-native-model"',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        "[model_providers.official-plugin-native]",
        'name = "Official plugin native fixture"',
        `base_url = "http://127.0.0.1:${address.port}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "[analytics]",
        "enabled = false",
        "",
      ].join("\n"),
    );

    const binary = await stageCodexBinary();
    const bridge = await buildCodexBridge();
    const wrapper = join(
      import.meta.dirname!,
      "..",
      "..",
      "..",
      "scripts",
      "test-codex-official-plugin-native-bridge-wrapper.mjs",
    );
    const host = await startBridge({
      cwd: workspaceA,
      identity: workspaceA,
      codexHome,
      bridgeHome,
      catalog: catalogPath,
      artifact: artifactPath,
      bridge,
      wrapper,
    });
    try {
      const overview = await host.rpc<{
        availablePlugins: Array<{ id: string; officialWarnings?: string[] }>;
      }>("plugins/overview", {
        workspace: {
          workspacePath: workspaceA,
          workspaceKey: workspaceA,
          workspaceIdentity: workspaceA,
        },
      });
      assert.ok(
        overview.availablePlugins.some((item) => item.id === `${PLUGIN_NAME}@${MARKETPLACE}`),
      );
      const available = overview.availablePlugins.find(
        (item) => item.id === `${PLUGIN_NAME}@${MARKETPLACE}`,
      );
      assert.ok(
        available?.officialWarnings?.some((warning) => /unquoted shell syntax/i.test(warning)),
      );
      const installed = await host.rpc<{
        installedPlugins: Array<{ id: string }>;
        diagnostics: Array<{ code?: string; severity?: string }>;
      }>("plugins/install", {
        workspace: {
          workspacePath: workspaceA,
          workspaceKey: workspaceA,
          workspaceIdentity: workspaceA,
        },
        pluginName: PLUGIN_NAME,
        marketplace: MARKETPLACE,
        operationId: "official-plugin-native-install",
        scope: "user",
      });
      assert.equal(installed.installedPlugins[0]?.id, `${PLUGIN_NAME}@${MARKETPLACE}`);
      assert.equal(
        installed.diagnostics.some((entry) => entry.code === "codex_official_hook_trust_failed"),
        false,
      );
    } finally {
      await host.close();
    }

    // refresh/install 只登记原生路径；数据目录应由后续真实 MCP 执行创建。
    await assert.rejects(stat(dataRoot), /ENOENT/);
    const generated = join(bridgeHome, "official-codex-marketplace");
    const generatedFiles = await readdir(generated, { recursive: true });
    for (const file of generatedFiles) {
      const path = join(generated, String(file));
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch {
        continue;
      }
      assert.doesNotMatch(content, new RegExp(workspaceA, "g"), `${file} baked workspace A`);
      assert.doesNotMatch(content, new RegExp(workspaceB, "g"), `${file} baked workspace B`);
    }

    await runScenario({
      label: "workspace-a",
      cwd: workspaceA,
      identity: workspaceA,
      codexHome,
      binary,
      port: address.port,
      dataRoot,
    });
    await runScenario({
      label: "workspace-b",
      cwd: workspaceB,
      identity: workspaceB,
      codexHome,
      binary,
      port: address.port,
      dataRoot,
    });
    await runScenario({
      label: "same-cwd-identity-b",
      cwd: workspaceA,
      identity: "native-identity-b",
      codexHome,
      binary,
      port: address.port,
      dataRoot,
    });
    await assertNativeToolTimeout({
      cwd: workspaceA,
      identity: workspaceA,
      codexHome,
      binary,
      port: address.port,
    });

    await assert.doesNotReject(stat(join(dataRoot, "mcp-report.json")));
    await assert.rejects(stat(join(dataRoot, "unsafe-ran.json")), /ENOENT/);
    await assert.rejects(stat(join(workspaceA, "unsafe-ran.json")), /ENOENT/);
    await assert.rejects(stat(join(workspaceB, "unsafe-ran.json")), /ENOENT/);
  },
);
