import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { transpileOfficialPlugin } from "../src/official-plugin-transpile.js";

async function fixtureDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "transpile-test-"));
}

async function writeJson(dir: string, relative: string, value: unknown): Promise<void> {
  const path = join(dir, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

const BASE = {
  bakedPluginRoot: "/materialized/plugins/demo/1.0.0",
  zcodeBaseUrl: "https://zcode.z.ai",
  expectedName: "demo",
  expectedVersion: "1.0.0",
};

test("pure skills + plain stdio MCP plugin passes through unchanged", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".claude-plugin/plugin.json", { name: "demo", version: "1.0.0" });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        demo: { type: "stdio", command: "npx", args: ["-y", "demo-mcp@1.0.0"], enabled: true },
      },
    });
    await mkdir(join(dir, "skills/demo"), { recursive: true });
    await writeFile(join(dir, "skills/demo/SKILL.md"), "---\nname: demo\n---\n", "utf8");

    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: dir });
    assert.equal(result.installation, "AVAILABLE");
    assert.equal(result.warnings.length, 0);
    assert.equal(result.requiresOfficialAuth, false);
    assert.deepEqual(result.components.mcpServers, ["demo"]);
    const mcp = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    assert.equal(mcp.mcpServers.demo.command, "npx");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("zcode-only manifest is synthesized and official http auth becomes bearer env var", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".zcode-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
      description: "Finance data",
      displayName: "金融聚合搜索",
      requiresPaidPlan: true,
    });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        "finance-search": {
          type: "http",
          url: "${ZCODE_BASE_URL}/api/v1/mcp/server/finance_search",
          auth: { type: "zcode_official", provider: "jwt_token" },
        },
      },
    });

    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: dir });
    assert.equal(result.installation, "AVAILABLE");
    assert.equal(result.requiresOfficialAuth, true);
    assert.equal(result.requiresPaidPlan, true);

    const manifest = JSON.parse(await readFile(join(dir, ".claude-plugin/plugin.json"), "utf8"));
    assert.equal(manifest.name, "demo");
    assert.equal(manifest.interface.displayName, "金融聚合搜索");
    assert.equal(manifest.requiresPaidPlan, undefined);

    const mcp = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    const server = mcp.mcpServers["finance-search"];
    assert.equal(server.url, "https://zcode.z.ai/api/v1/mcp/server/finance_search");
    assert.equal(server.auth, undefined);
    assert.equal(server.bearer_token_env_var, "CODEZ_ZAI_OFFICIAL_MCP_TOKEN");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mimosa-style plugin: userConfig defaults bake, project cwd drops, process hooks convert", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".claude-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
      commands: "payload/commands",
      skills: "payload/skills",
      userConfig: { engine: { type: "string", default: "native" } },
    });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        demo: {
          type: "stdio",
          command: "node",
          args: ["${ZCODE_PLUGIN_ROOT}/payload/dist/mcp/server.js"],
          cwd: "${ZCODE_PROJECT_DIR}",
          env: { DEMO_ENGINE: "${user_config.engine}" },
          timeoutMs: 120000,
        },
      },
    });
    await writeJson(dir, "hooks/hooks.json", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write|MultiEdit",
            hooks: [
              {
                type: "process",
                command: "node",
                args: ["${ZCODE_PLUGIN_ROOT}/payload/hooks/scan-hook.mjs"],
                timeoutMs: 120000,
                statusMessage: "scanning",
              },
            ],
          },
        ],
        Notification: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      },
    });
    await mkdir(join(dir, "payload/skills/demo"), { recursive: true });
    await writeFile(join(dir, "payload/skills/demo/SKILL.md"), "---\nname: demo\n---\n", "utf8");

    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: dir });
    assert.equal(result.installation, "AVAILABLE");
    assert.equal(result.hasHooks, true);

    const mcp = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    const server = mcp.mcpServers.demo;
    assert.equal(server.args[0], "/materialized/plugins/demo/1.0.0/payload/dist/mcp/server.js");
    assert.equal(server.cwd, undefined);
    assert.equal(server.env.DEMO_ENGINE, "native");

    const manifest = JSON.parse(await readFile(join(dir, ".claude-plugin/plugin.json"), "utf8"));
    assert.equal(manifest.skills, "./payload/skills");
    assert.equal(manifest.commands, "./payload/commands");
    assert.equal(manifest.userConfig, undefined);

    const hooks = JSON.parse(await readFile(join(dir, "hooks/hooks.json"), "utf8"));
    const handler = hooks.hooks.PreToolUse[0].hooks[0];
    assert.equal(handler.type, "command");
    assert.equal(handler.command, 'node "${CLAUDE_PLUGIN_ROOT}/payload/hooks/scan-hook.mjs"');
    assert.equal(handler.timeout, 120);
    assert.equal(handler.statusMessage, "scanning");
    // 不认识的事件被丢弃并留下警告。
    assert.equal(hooks.hooks.Notification, undefined);
    assert.ok(result.warnings.some((warning) => warning.includes("Notification")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("content scan flags ZCode-only runtime coupling as a warning, not a block", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".claude-plugin/plugin.json", { name: "demo", version: "1.0.0" });
    await mkdir(join(dir, "skills/demo"), { recursive: true });
    await writeFile(
      join(dir, "skills/demo/SKILL.md"),
      "Use node_repl and the BrowserRecordingAPI to record.",
      "utf8",
    );
    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: dir });
    assert.equal(result.installation, "AVAILABLE");
    assert.ok(result.warnings.some((warning) => warning.includes("node_repl")));
    assert.ok(result.warnings.some((warning) => warning.includes("browser recording")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("plugins without any usable manifest or surviving component are unavailable", async () => {
  const dir = await fixtureDir();
  try {
    await writeFile(join(dir, "README.md"), "nothing", "utf8");
    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: dir });
    assert.equal(result.installation, "NOT_AVAILABLE");
    assert.match(result.unavailableReason ?? "", /manifest/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const mismatch = await fixtureDir();
  try {
    await writeJson(mismatch, ".claude-plugin/plugin.json", { name: "demo", version: "9.9.9" });
    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: mismatch });
    assert.equal(result.installation, "NOT_AVAILABLE");
    assert.match(result.unavailableReason ?? "", /name\/version/);
  } finally {
    await rm(mismatch, { recursive: true, force: true });
  }

  const channels = await fixtureDir();
  try {
    await writeJson(channels, ".claude-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
      channels: {},
    });
    await mkdir(join(channels, "skills/demo"), { recursive: true });
    await writeFile(join(channels, "skills/demo/SKILL.md"), "x", "utf8");
    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: channels });
    assert.equal(result.installation, "NOT_AVAILABLE");
    assert.match(result.unavailableReason ?? "", /channels/);
  } finally {
    await rm(channels, { recursive: true, force: true });
  }
});

test("an MCP-only plugin whose servers cannot be adapted is unavailable", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".zcode-plugin/plugin.json", { name: "demo", version: "1.0.0" });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        legacy: { type: "sse", url: "https://example.invalid/sse" },
        misconfigured: { type: "stdio", env: { TOKEN: "${user_config.missing}" }, command: "x" },
      },
    });
    const result = await transpileOfficialPlugin({ ...BASE, pluginDir: dir });
    assert.equal(result.installation, "NOT_AVAILABLE");
    assert.match(result.unavailableReason ?? "", /MCP/);
    const mcp = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(mcp.mcpServers), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
