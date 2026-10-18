import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CODEZ_CUA_OFFICIAL_PLUGIN_ID,
  CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME,
} from "@codez/shared";
import type { CodezPluginsSetEnabledResult } from "@codez/shared";
import {
  CODEX_NATIVE_CUA_SKILL_MARKDOWN,
  CODEX_NATIVE_CUA_SKILL_NAME,
  resolveCodexNativeCuaSkillFilePath,
} from "./codexNativeCuaSkill.js";
import { createPluginManagementService } from "./pluginManagementService.js";

const CUA_RESULT = {
  enabled: true,
  plugin: { id: CODEZ_CUA_OFFICIAL_PLUGIN_ID },
} as unknown as CodezPluginsSetEnabledResult;

const TARGET = {
  workspacePath: "C:\\workspace",
  workspaceIdentity: "desktop-local:test",
  pluginId: CODEZ_CUA_OFFICIAL_PLUGIN_ID,
  enabled: true,
} as const;

function createService(input: {
  setPluginEnabled?: () => Promise<CodezPluginsSetEnabledResult>;
  disposeWorkspace?: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
}) {
  return createPluginManagementService({
    codezAgentService: {
      setPluginEnabled: input.setPluginEnabled ?? (async () => CUA_RESULT),
      disposeWorkspace: input.disposeWorkspace ?? (async () => undefined),
    } as never,
  });
}

test("successful Computer Use toggle invalidates only the target workspace runtime", async () => {
  const disposed: Array<{ workspacePath: string; workspaceIdentity?: string }> = [];
  const service = createService({
    disposeWorkspace: async (params) => void disposed.push(params),
  });

  const result = await service.setPluginEnabled(TARGET);

  assert.equal(result, CUA_RESULT);
  assert.deepEqual(disposed, [
    {
      workspacePath: TARGET.workspacePath,
      workspaceIdentity: TARGET.workspaceIdentity,
    },
  ]);
});

test("other plugin toggles do not use the Computer Use runtime invalidation path", async () => {
  let disposeCount = 0;
  const service = createService({
    disposeWorkspace: async () => void (disposeCount += 1),
  });

  await service.setPluginEnabled({
    ...TARGET,
    pluginId: "example@marketplace",
  });

  assert.equal(disposeCount, 0);
});

test("failed Computer Use config write does not invalidate the workspace runtime", async () => {
  let disposeCount = 0;
  const service = createService({
    setPluginEnabled: async () => {
      throw new Error("config write failed");
    },
    disposeWorkspace: async () => void (disposeCount += 1),
  });

  await assert.rejects(service.setPluginEnabled(TARGET), /config write failed/u);
  assert.equal(disposeCount, 0);
});

test("runtime cleanup failure does not roll back a persisted Computer Use toggle", async () => {
  const service = createService({
    disposeWorkspace: async () => {
      throw new Error("cleanup failed");
    },
  });

  assert.equal(await service.setPluginEnabled(TARGET), CUA_RESULT);
});

test("codexNativeCuaMode projects and persists Computer Use enablement in cli/config.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-cua-plugin-mgmt-"));
  const disposed: Array<{ workspacePath: string; workspaceIdentity?: string }> = [];
  let agentSetEnabledCalls = 0;
  try {
    const env = { CODEZ_HOME: root, HOME: root, USERPROFILE: root };
    const skillFilePath = resolveCodexNativeCuaSkillFilePath(env);
    const service = createPluginManagementService({
      codexNativeCuaMode: true,
      env,
      codezAgentService: {
        listPlugins: async () => ({ plugins: [], diagnostics: [] }),
        getPluginsOverview: async () => ({
          marketplaces: [],
          availablePlugins: [],
          installedPlugins: [],
          restorableBuiltins: [],
          diagnostics: [],
          capability: { supported: true },
        }),
        setPluginEnabled: async () => {
          agentSetEnabledCalls += 1;
          return CUA_RESULT;
        },
        disposeWorkspace: async (params: { workspacePath: string; workspaceIdentity?: string }) =>
          void disposed.push(params),
      } as never,
    });

    const initialList = await service.listPlugins({ workspacePath: "/workspace" });
    assert.equal(initialList.plugins.length, 1);
    assert.equal(initialList.plugins[0]?.id, CODEZ_CUA_OFFICIAL_PLUGIN_ID);
    assert.equal(initialList.plugins[0]?.enabled, false);
    assert.deepEqual(
      initialList.plugins[0]?.components
        ?.find((group) => group.kind === "skill")
        ?.items.map((item) => item.name),
      [CODEX_NATIVE_CUA_SKILL_NAME],
    );
    assert.deepEqual(initialList.plugins[0]?.mcpServerNames, [
      CODEZ_NATIVE_BROWSER_CUA_MCP_SERVER_NAME,
    ]);

    const toggled = await service.setPluginEnabled({
      workspacePath: "/workspace",
      pluginId: CODEZ_CUA_OFFICIAL_PLUGIN_ID,
      enabled: true,
    });
    assert.equal(toggled.enabled, true);
    assert.equal(agentSetEnabledCalls, 0);
    assert.deepEqual(disposed, [{ workspacePath: "/workspace" }]);

    const persisted = JSON.parse(await readFile(join(root, "cli", "config.json"), "utf8"));
    assert.equal(persisted.plugins.enabledPlugins[CODEZ_CUA_OFFICIAL_PLUGIN_ID], true);
    const materializedSkill = await readFile(skillFilePath, "utf8");
    assert.equal(materializedSkill, CODEX_NATIVE_CUA_SKILL_MARKDOWN);
    assert.match(materializedSkill, /^---\nname: codez-computer-use\n/u);
    assert.match(materializedSkill, /cua_command/u);

    const afterList = await service.listPlugins({ workspacePath: "/workspace" });
    assert.equal(afterList.plugins[0]?.enabled, true);
    const afterOverview = await service.getPluginsOverview({ workspacePath: "/workspace" });
    assert.equal(afterOverview.installedPlugins[0]?.id, CODEZ_CUA_OFFICIAL_PLUGIN_ID);
    assert.equal(afterOverview.installedPlugins[0]?.enabled, true);

    await service.setPluginEnabled({
      workspacePath: "/workspace",
      pluginId: CODEZ_CUA_OFFICIAL_PLUGIN_ID,
      enabled: false,
    });
    await assert.rejects(readFile(skillFilePath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codexNativeCuaMode preserves user-authored non-managed skill file when toggling off", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-cua-custom-skill-"));
  try {
    const env = { CODEZ_HOME: root, HOME: root, USERPROFILE: root };
    const skillFilePath = resolveCodexNativeCuaSkillFilePath(env);
    await mkdir(dirname(skillFilePath), { recursive: true });
    const customContent = "---\nname: codez-computer-use\ndescription: custom\n---\nCustom body\n";
    await writeFile(skillFilePath, customContent, "utf8");

    const service = createPluginManagementService({
      codexNativeCuaMode: true,
      env,
      codezAgentService: {
        listPlugins: async () => ({ plugins: [], diagnostics: [] }),
        getPluginsOverview: async () => ({
          marketplaces: [],
          availablePlugins: [],
          installedPlugins: [],
          restorableBuiltins: [],
          diagnostics: [],
          capability: { supported: true },
        }),
        setPluginEnabled: async () => CUA_RESULT,
        disposeWorkspace: async () => undefined,
      } as never,
    });

    await service.setPluginEnabled({
      workspacePath: "/workspace",
      pluginId: CODEZ_CUA_OFFICIAL_PLUGIN_ID,
      enabled: true,
    });
    assert.equal(await readFile(skillFilePath, "utf8"), customContent);

    await service.setPluginEnabled({
      workspacePath: "/workspace",
      pluginId: CODEZ_CUA_OFFICIAL_PLUGIN_ID,
      enabled: false,
    });
    assert.equal(await readFile(skillFilePath, "utf8"), customContent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repo skills-codex/codez-computer-use/SKILL.md stays in sync with CODEX_NATIVE_CUA_SKILL_MARKDOWN", async () => {
  const repoSkillPath = new URL(
    "../../../../apps/codez-cli/packages/codez-cua-plugin/skills-codex/codez-computer-use/SKILL.md",
    import.meta.url,
  );
  const repoSkillContent = await readFile(repoSkillPath, "utf8");
  assert.equal(repoSkillContent, CODEX_NATIVE_CUA_SKILL_MARKDOWN);
});
