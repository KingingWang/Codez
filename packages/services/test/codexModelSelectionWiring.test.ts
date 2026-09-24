import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Emitter } from "@codez/rpc";
import {
  appSettingsSchema,
  type CodexModel,
  type CodexRequest,
  type CodezProtocolMessage,
} from "@codez/shared";
import { createLocalServices, disposeServiceResourcesAndWait } from "../src/node.js";
import { IModelSelectionService } from "../src/model-provider/providerFacadeServices.js";
import { ProviderRuntime } from "../src/model-provider/providerRuntime.js";
import type { ISettingService } from "../src/setting/setting.js";
import { setDataBaseDir } from "../src/paths.js";
import { CodezAgentProcessManager } from "../src/codez-agent/codezAgentProcessManager.js";
import { CodezProtocolClient } from "../src/codez-agent/codezProtocolClient.js";

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

test("codex runtime：Host IModelSelectionService 走 Codex 原生目录，不启动 legacy Provider Registry", async (t) => {
  const savedEnv = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), "codez-codex-model-selection-"));
  setDataBaseDir(root);
  process.env.CODEZ_DESKTOP_HOME_DIR = root;
  delete process.env.CODEZ_AGENT_SERVER_COMMAND;
  delete process.env.CODEZ_DESKTOP_RUNTIME;
  delete process.env.CODEZ_CODEX_BRIDGE_PATH;
  process.env.CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED = "1";
  const clients: CodezProtocolClient[] = [];
  let legacyStarts = 0;
  t.mock.method(ProviderRuntime.prototype, "start", async () => {
    legacyStarts += 1;
    throw new Error("legacy provider must not be required");
  });
  t.mock.method(CodezAgentProcessManager.prototype, "getClient", async function () {
    const messages = new Emitter<CodezProtocolMessage>();
    const closes = new Emitter<{ reason?: string }>();
    const client = new CodezProtocolClient({
      kind: "memory",
      onMessage: messages.event,
      onClose: closes.event,
      async send(message) {
        if (!("method" in message && "id" in message)) return;
        let result: unknown;
        assert.equal(message.method, "codex/request", "模型事实只能来自 Codex 原生 RPC");
        const request = message.params as CodexRequest;
        if (request.method === "config/read") {
          result = {
            config: { model: "gpt-5-codex", model_reasoning_effort: "high" },
            origins: {},
            layers: null,
          };
        } else {
          assert.equal(request.method, "model/list");
          result = { data: [nativeModel("gpt-5-codex", true)], nextCursor: null };
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
  });
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
  const services = createLocalServices({
    settingService: settings,
    runtimeProcessEnvPatch: { PATH: savedEnv.PATH ?? "" },
    codezBuiltinProviderConfigFilePath: fileURLToPath(
      new URL("../../../config/provider/codez-builtin.json", import.meta.url),
    ),
    serviceAuthorityMode: "desktop-local",
    agentRuntimeContext: { runtimeSurface: "desktop_local_host" },
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
  try {
    const modelSelection = services.get(IModelSelectionService);
    // 无 workspace：空视图，不拉起 Codex 进程，也不触碰 legacy Registry。
    const globalView = await modelSelection.getView();
    assert.equal(globalView.providers.length, 0);
    assert.equal(clients.length, 0);

    const view = await modelSelection.getView({
      selection: null,
      workspace: { workspacePath: root },
    });
    assert.deepEqual(view.preferredSelection, {
      providerId: "openai",
      modelId: "gpt-5-codex",
      options: { reasoningLevel: "high" },
    });
    assert.equal(view.providers.length, 1);
    assert.deepEqual(view.providers[0]?.models[0]?.config.optionSpecs.reasoningLevel.values, [
      "medium",
    ]);

    const resolved = await modelSelection.getView({
      selection: { providerId: "openai", modelId: "gpt-5-codex" },
      workspace: { workspacePath: root },
    });
    assert.equal(resolved.selectionIssue, undefined);
    assert.deepEqual(resolved.effectiveSelection, {
      providerId: "openai",
      modelId: "gpt-5-codex",
      options: { reasoningLevel: "medium" },
    });
    assert.equal(legacyStarts, 0, "codex 模式不能启动 legacy Provider Runtime");
  } finally {
    await disposeServiceResourcesAndWait(services);
    for (const client of clients) client.dispose();
    setDataBaseDir(null);
    process.env = savedEnv;
    await rm(root, { recursive: true, force: true });
  }
});
