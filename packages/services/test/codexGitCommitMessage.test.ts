import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import {
  appSettingsSchema,
  resolveWorkspaceKey,
  zcodeWorkspaceGenerateTextParamsSchema,
  type CodexModel,
  type CodexRequest,
  type ModelSelection,
  type ZCodeProtocolMessage,
} from "@zcode/shared";
import { createLocalServices, disposeServiceResourcesAndWait } from "../src/node.js";
import { IGitService } from "../src/git/git.js";
import { ProviderRuntime } from "../src/model-provider/providerRuntime.js";
import type { ISettingService } from "../src/setting/setting.js";
import { setDataBaseDir } from "../src/paths.js";
import {
  ZCodeAgentProcessManager,
  type ZCodeAgentProcessManagerOptions,
} from "../src/zcode-agent/zcodeAgentProcessManager.js";
import { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.js";

const nativeModel = (model: string, isDefault = false): CodexModel => ({
  id: model,
  model,
  displayName: model,
  description: "fixture",
  hidden: false,
  isDefault,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "fixture" }],
});

test("Git native model discovery and auxiliary generation never prepare legacy providers", async (t) => {
  const savedEnv = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), "zcode-codex-git-"));
  setDataBaseDir(root);
  process.env.ZCODE_DESKTOP_HOME_DIR = root;
  delete process.env.ZCODE_AGENT_SERVER_COMMAND;
  delete process.env.ZCODE_DESKTOP_RUNTIME;
  delete process.env.ZCODE_CODEX_BRIDGE_PATH;
  process.env.ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED = "1";
  const calls: Array<{ identity: string; method: string; params: unknown }> = [];
  const clients: ZCodeProtocolClient[] = [];
  let config: Record<string, unknown> = {};
  let pages: Array<{ data: CodexModel[]; nextCursor: string | null }> = [];
  let invalidConfig = false;
  let generationFails = false;
  let generatedSelection: ModelSelection | undefined;
  let starts = 0;
  t.mock.method(ProviderRuntime.prototype, "start", async () => {
    starts += 1;
    throw new Error("legacy provider must not be required");
  });
  t.mock.method(
    ZCodeAgentProcessManager.prototype,
    "getClient",
    async function (
      this: ZCodeAgentProcessManager,
      workspace: { workspacePath: string; workspaceIdentity?: string },
    ) {
      const identity = resolveWorkspaceKey(workspace);
      const manager = this as unknown as Pick<ZCodeAgentProcessManagerOptions, "resolveSpawnEnv">;
      await manager.resolveSpawnEnv?.({ ...workspace, workspaceKey: identity });
      const messages = new Emitter<ZCodeProtocolMessage>();
      const closes = new Emitter<{ reason?: string }>();
      const client = new ZCodeProtocolClient({
        kind: "memory",
        onMessage: messages.event,
        onClose: closes.event,
        async send(message) {
          if (!("method" in message && "id" in message)) return;
          calls.push({ identity, method: message.method, params: message.params });
          let result: unknown;
          if (message.method === "codex/request") {
            const request = message.params as CodexRequest;
            if (request.method === "config/read") {
              assert.deepEqual(request.params, { cwd: root, includeLayers: false });
              result = invalidConfig ? {} : { config, origins: {}, layers: null };
            } else {
              assert.equal(request.method, "model/list");
              const params = request.params as { cursor?: string; includeHidden: boolean };
              assert.equal(params.includeHidden, false);
              result = pages[params.cursor ? 1 : 0];
            }
          } else {
            assert.equal(
              message.method,
              "workspace/generateText",
              "no legacy readiness/account/tool RPCs",
            );
            const params = zcodeWorkspaceGenerateTextParamsSchema.parse(message.params);
            assert.equal(params.workspace.workspacePath, root);
            assert.equal(params.workspace.workspaceIdentity, identity);
            assert.equal(params.querySource, "git_commit_message");
            generatedSelection = params.selection;
            if (generationFails) {
              messages.fire({
                id: message.id,
                error: { code: -32000, message: "native auxiliary refused" },
              });
              return;
            }
            result = { text: "fix: use native model for git", selection: params.selection };
          }
          messages.fire({ id: message.id, result });
        },
        dispose() {
          messages.dispose();
          closes.dispose();
        },
      });
      clients.push(client);
      return client;
    },
  );
  const settings: ISettingService = {
    async get() {
      return appSettingsSchema.parse({});
    },
    async update() {
      assert.fail("fixture settings are read-only");
    },
    async updateDataBaseDir() {
      assert.fail("fixture settings are read-only");
    },
    async ensureDefaultProject() {
      assert.fail("fixture must not create projects");
    },
  };
  try {
    await promisify(execFile)("git", ["-c", "init.defaultBranch=main", "init", root]);
    await writeFile(join(root, "example.txt"), "native Git fixture\n");
    for (const runtime of ["local", "deployed", "explicit-legacy", "custom-legacy"] as const) {
      delete process.env.ZCODE_CODEX_BRIDGE_PATH;
      delete process.env.ZCODE_AGENT_SERVER_COMMAND;
      if (runtime === "deployed") process.env.ZCODE_CODEX_BRIDGE_PATH = "/remote/codex/bridge.cjs";
      if (runtime === "explicit-legacy") process.env.ZCODE_AGENT_SERVER_COMMAND = "/legacy/agent";
      const services = createLocalServices({
        settingService: settings,
        runtimeProcessEnvPatch: { PATH: savedEnv.PATH ?? "" },
        zcodeBuiltinProviderConfigFilePath: fileURLToPath(
          new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
        ),
        serviceAuthorityMode: runtime === "deployed" ? "desktop-attached-remote" : "desktop-local",
        agentRuntimeContext: {
          runtimeSurface: runtime === "deployed" ? "remote_workspace_host" : "desktop_local_host",
        },
        ...(runtime === "custom-legacy" ? { zcodeAgentCommandResolver: () => null } : {}),
        prepareLegacyAccountConnections: async () => {
          assert.fail("must not prepare legacy account");
        },
        hostApiNetworkTransport: {
          fetch: async () => {
            assert.fail("must not call legacy APIs");
          },
          dispose() {},
          async disposeAndWait() {},
        },
      });
      const git = services.get(IGitService);
      const target = { workspacePath: root, workspaceIdentity: `native-git-${runtime}` };
      const generate = () => git.generateCommitMessage(target);
      try {
        if (runtime === "explicit-legacy" || runtime === "custom-legacy") {
          const before = calls.length;
          await assert.rejects(generate(), /legacy provider must not be required/);
          assert.equal(calls.length, before, "legacy model lookup must not call native Codex");
          continue;
        }
        config = {
          model_provider: "custom-native",
          model: "configured-only",
          model_reasoning_effort: "high",
        };
        pages = [{ data: [nativeModel("other-model", true)], nextCursor: null }];
        const result = await generate();
        assert.deepEqual(result, {
          message: "fix: use native model for git",
          providerId: "custom-native",
          model: "configured-only",
        });
        assert.deepEqual(generatedSelection, {
          providerId: "custom-native",
          modelId: "configured-only",
          options: { reasoningLevel: "high" },
        });

        config = { model_provider: "custom-native", model: "configured-only" };
        await generate();
        assert.deepEqual(generatedSelection, {
          providerId: "custom-native",
          modelId: "configured-only",
        });

        config = {};
        pages = [
          { data: [nativeModel("not-default")], nextCursor: "page-2" },
          { data: [nativeModel("native-default", true)], nextCursor: null },
        ];
        await generate();
        assert.deepEqual(generatedSelection, {
          providerId: "openai",
          modelId: "native-default",
          options: { reasoningLevel: "medium" },
        });
        config = { model: "native-default" };
        await generate();
        assert.equal(generatedSelection?.modelId, "native-default");

        for (const failure of ["missing", "invalid", "cycle"] as const) {
          config = {};
          invalidConfig = failure === "invalid";
          pages =
            failure === "cycle"
              ? [
                  { data: [], nextCursor: "repeat" },
                  { data: [], nextCursor: "repeat" },
                ]
              : [{ data: [], nextCursor: null }];
          const before = calls.filter((call) => call.method === "workspace/generateText").length;
          await assert.rejects(generate());
          assert.equal(
            calls.filter((call) => call.method === "workspace/generateText").length,
            before,
          );
        }
        invalidConfig = false;
        config = { model: "configured-only" };
        pages = [{ data: [], nextCursor: null }];
        generationFails = true;
        const before = calls.filter((call) => call.method === "workspace/generateText").length;
        await assert.rejects(generate(), /模型请求失败/);
        assert.equal(
          calls.filter((call) => call.method === "workspace/generateText").length,
          before + 1,
          "failed mutations are not retried",
        );
        generationFails = false;
        assert.equal(starts, 0);
        assert.ok(
          calls.every(
            (call) =>
              call.identity === "native-git-local" || call.identity === "native-git-deployed",
          ),
        );
      } finally {
        await disposeServiceResourcesAndWait(services);
      }
    }
  } finally {
    for (const client of clients) client.dispose();
    setDataBaseDir(null);
    process.env = savedEnv;
    await rm(root, { recursive: true, force: true });
  }
});
