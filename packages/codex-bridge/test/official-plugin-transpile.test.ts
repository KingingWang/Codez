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

async function transpileFixture(
  dir: string,
): Promise<Awaited<ReturnType<typeof transpileOfficialPlugin>>> {
  return await transpileOfficialPlugin({
    bakedPluginRoot: "/materialized/plugins/demo/1.0.0",
    nativeDataRoot: join(dir, "native-data"),
    zcodeBaseUrl: "https://zcode.z.ai",
    expectedName: "demo",
    expectedVersion: "1.0.0",
    pluginDir: dir,
  });
}

test("pure skills + plain stdio MCP plugin passes through unchanged", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".claude-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
    });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        demo: {
          type: "stdio",
          command: "npx",
          args: ["-y", "demo-mcp@1.0.0"],
          enabled: true,
        },
      },
    });
    await mkdir(join(dir, "skills/demo"), { recursive: true });
    await writeFile(join(dir, "skills/demo/SKILL.md"), "---\nname: demo\n---\n", "utf8");

    const result = await transpileFixture(dir);
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

    const result = await transpileFixture(dir);
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

test("官方 stdio MCP 继承项目变量与原生数据根，并保留精确秒级超时", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".claude-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
    });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        demo: {
          type: "stdio",
          command: "node",
          args: ["server.js"],
          env: {
            ZCODE_PROJECT_DIR: "${ZCODE_PROJECT_DIR}",
            CLAUDE_PROJECT_DIR: "${CLAUDE_PROJECT_DIR}",
            ZCODE_WORKSPACE_ROOT: "${ZCODE_PROJECT_DIR}",
          },
          env_vars: [
            { name: "ZCODE_PROJECT_DIR", source: "local" },
            { name: "UNRELATED", source: "local" },
          ],
          timeoutMs: 1500,
        },
      },
    });
    await mkdir(join(dir, "skills/demo"), { recursive: true });
    await writeFile(join(dir, "skills/demo/SKILL.md"), "x", "utf8");

    const result = await transpileFixture(dir);
    assert.equal(result.installation, "AVAILABLE");
    const server = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8")).mcpServers.demo;
    assert.deepEqual(server.env, {
      ZCODE_PLUGIN_DATA: join(dir, "native-data"),
      CLAUDE_PLUGIN_DATA: join(dir, "native-data"),
    });
    assert.deepEqual(server.env_vars, [
      { name: "ZCODE_PROJECT_DIR", source: "local" },
      { name: "UNRELATED", source: "local" },
      { name: "CLAUDE_PROJECT_DIR", source: "local" },
      { name: "ZCODE_WORKSPACE_ROOT", source: "local" },
      { name: "ZCODE_WORKSPACE_IDENTITY", source: "local" },
    ]);
    assert.equal(server.env.ZCODE_PLUGIN_DATA, join(dir, "native-data"));
    assert.equal(server.env.CLAUDE_PLUGIN_DATA, join(dir, "native-data"));
    assert.equal(server.timeoutMs, undefined);
    assert.equal(server.tool_timeout_sec, 1.5);
    assert.equal(result.warnings.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env_vars 字符串与对象语义等价去重", async () => {
  for (const existing of ["ZCODE_PROJECT_DIR", { name: "ZCODE_PROJECT_DIR", source: "local" }]) {
    const dir = await fixtureDir();
    try {
      await writeJson(dir, ".claude-plugin/plugin.json", {
        name: "demo",
        version: "1.0.0",
      });
      await writeJson(dir, ".mcp.json", {
        mcpServers: {
          demo: {
            type: "stdio",
            command: "x",
            env: { ZCODE_PROJECT_DIR: "${ZCODE_PROJECT_DIR}" },
            env_vars: [existing],
          },
        },
      });
      await mkdir(join(dir, "skills/demo"), { recursive: true });
      await writeFile(join(dir, "skills/demo/SKILL.md"), "x", "utf8");
      const result = await transpileFixture(dir);
      assert.equal(result.installation, "AVAILABLE");
      assert.equal(result.warnings.length, 0);
      const server = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8")).mcpServers.demo;
      assert.deepEqual(server.env_vars, [
        existing,
        { name: "ZCODE_WORKSPACE_IDENTITY", source: "local" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("官方 HTTP MCP 不注入 stdio 专属项目、identity 与数据字段", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".claude-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
    });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        demo: {
          type: "http",
          url: "https://example.invalid/mcp",
          timeoutMs: 1000,
        },
      },
    });
    await mkdir(join(dir, "skills/demo"), { recursive: true });
    await writeFile(join(dir, "skills/demo/SKILL.md"), "x", "utf8");

    const result = await transpileFixture(dir);
    assert.equal(result.installation, "AVAILABLE");
    const server = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8")).mcpServers.demo;
    assert.equal(server.env_vars, undefined);
    assert.equal(server.env, undefined);
    assert.equal(server.ZCODE_WORKSPACE_IDENTITY, undefined);
    assert.equal(server.ZCODE_PLUGIN_DATA, undefined);
    assert.equal(server.CLAUDE_PLUGIN_DATA, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP MCP 已声明 env_vars 时 fail-visible 丢弃 server", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".claude-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
    });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        demo: {
          type: "http",
          url: "https://example.invalid/mcp",
          env_vars: ["ZCODE_WORKSPACE_IDENTITY"],
        },
      },
    });
    await mkdir(join(dir, "skills/demo"), { recursive: true });
    await writeFile(join(dir, "skills/demo/SKILL.md"), "x", "utf8");
    const result = await transpileFixture(dir);
    assert.equal(result.installation, "NOT_AVAILABLE");
    assert.deepEqual(result.components.mcpServers, []);
    assert.ok(result.warnings.some((warning) => warning.includes("env_vars")));
    const mcp = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(mcp.mcpServers), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("不支持的项目变量、保留变量字面量与非法超时会降级单个 server", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".claude-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
    });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        good: { type: "stdio", command: "x" },
        badKey: {
          type: "stdio",
          command: "x",
          env: { OTHER_PROJECT_DIR: "${ZCODE_PROJECT_DIR}" },
        },
        partial: {
          type: "stdio",
          command: "x",
          env: { ZCODE_PROJECT_DIR: "prefix/${ZCODE_PROJECT_DIR}/suffix" },
        },
        staleIdentity: {
          type: "stdio",
          command: "x",
          env: { ZCODE_WORKSPACE_IDENTITY: "literal-identity" },
        },
        staleData: {
          type: "stdio",
          command: "x",
          env: { ZCODE_PLUGIN_DATA: "/stale/data" },
        },
        zeroTimeout: { type: "stdio", command: "x", timeoutMs: 0 },
        conflictingTimeout: {
          type: "stdio",
          command: "x",
          timeoutMs: 1000,
          tool_timeout_sec: 2,
        },
      },
    });
    await mkdir(join(dir, "skills/demo"), { recursive: true });
    await writeFile(join(dir, "skills/demo/SKILL.md"), "x", "utf8");

    const result = await transpileFixture(dir);
    assert.equal(result.installation, "AVAILABLE");
    assert.deepEqual(result.components.mcpServers, ["good"]);
    const mcp = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(mcp.mcpServers), ["good"]);
    const expectedWarnings = [
      "badKey",
      "partial",
      "staleIdentity",
      "ZCODE_PLUGIN_DATA",
      "zeroTimeout",
      "conflictingTimeout",
    ];
    for (const fragment of expectedWarnings) {
      assert.ok(
        result.warnings.some((warning) => warning.includes(fragment)),
        fragment,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("timeoutMs 仅在 positive safe integer 时转换且保留既有 tool_timeout_sec", async () => {
  const cases = [
    { timeoutMs: 1, expected: 0.001 },
    { timeoutMs: 999, expected: 0.999 },
    { timeoutMs: 1000, expected: 1 },
    { timeoutMs: 900000, expected: 900 },
  ];
  for (const item of cases) {
    const dir = await fixtureDir();
    try {
      await writeJson(dir, ".claude-plugin/plugin.json", {
        name: "demo",
        version: "1.0.0",
      });
      await writeJson(dir, ".mcp.json", {
        mcpServers: {
          demo: { type: "stdio", command: "x", timeoutMs: item.timeoutMs },
        },
      });
      await mkdir(join(dir, "skills/demo"), { recursive: true });
      await writeFile(join(dir, "skills/demo/SKILL.md"), "x", "utf8");
      await transpileFixture(dir);
      const server = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8")).mcpServers.demo;
      assert.equal(server.timeoutMs, undefined);
      assert.equal(server.tool_timeout_sec, item.expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".claude-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
    });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        demo: { type: "stdio", command: "x", tool_timeout_sec: 2.25 },
      },
    });
    await mkdir(join(dir, "skills/demo"), { recursive: true });
    await writeFile(join(dir, "skills/demo/SKILL.md"), "x", "utf8");
    await transpileFixture(dir);
    const server = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8")).mcpServers.demo;
    assert.equal(server.timeoutMs, undefined);
    assert.equal(server.tool_timeout_sec, 2.25);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("非法 timeout 值包括非整数、非有限数与上下界外的 safe-integer 失败", async () => {
  const invalidValues = [-1, NaN, Infinity, -Infinity, 1.5, 9007199254740992];
  for (const timeoutMs of invalidValues) {
    const dir = await fixtureDir();
    try {
      await writeJson(dir, ".claude-plugin/plugin.json", {
        name: "demo",
        version: "1.0.0",
      });
      await writeJson(dir, ".mcp.json", {
        mcpServers: { demo: { type: "stdio", command: "x", timeoutMs } },
      });
      await mkdir(join(dir, "skills/demo"), { recursive: true });
      await writeFile(join(dir, "skills/demo/SKILL.md"), "x", "utf8");
      const result = await transpileFixture(dir);
      assert.equal(result.components.mcpServers.length, 0);
      assert.ok(result.warnings.some((warning) => warning.includes("timeout")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("MCP-only 插件全部 server 被保留变量/非法值降级后不可安装", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".zcode-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
    });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        demo: {
          type: "stdio",
          command: "x",
          env: { ZCODE_WORKSPACE_IDENTITY: "explicit" },
        },
      },
    });
    const result = await transpileFixture(dir);
    assert.equal(result.installation, "NOT_AVAILABLE");
    assert.match(result.unavailableReason ?? "", /MCP/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP-only 插件的未知 transport 全部丢弃并生成明确 warning", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".zcode-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
    });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        websocket: { type: "websocket", url: "https://example.invalid/mcp" },
        streamable: { type: "streamable", url: "https://example.invalid/mcp" },
        empty: { type: "", url: "https://example.invalid/mcp" },
        custom: { type: "zcode-custom", url: "https://example.invalid/mcp" },
      },
    });

    const result = await transpileFixture(dir);
    assert.equal(result.installation, "NOT_AVAILABLE");
    assert.match(result.unavailableReason ?? "", /MCP/);
    assert.deepEqual(result.components.mcpServers, []);
    for (const serverName of ["websocket", "streamable", "empty", "custom"]) {
      assert.ok(
        result.warnings.some((warning) => warning.includes(serverName)),
        `missing warning for ${serverName}`,
      );
    }
    const mcp = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(mcp.mcpServers), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP-only 插件的 malformed transport 立即丢弃且缺失时才推断", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".zcode-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
    });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        numeric: { type: 3, command: "x" },
        object: { type: {}, command: "x" },
        null: { type: null, command: "x" },
        array: { type: ["stdio"], command: "x" },
        inferredStdio: { command: "x" },
        inferredHttp: { url: "https://example.invalid/mcp" },
      },
    });

    const result = await transpileFixture(dir);
    assert.equal(result.installation, "AVAILABLE");
    assert.equal(result.unavailableReason, undefined);
    assert.deepEqual(result.components.mcpServers, ["inferredStdio", "inferredHttp"]);
    for (const serverName of ["numeric", "object", "null", "array"]) {
      assert.ok(
        result.warnings.some((warning) => warning.includes(serverName)),
        `missing warning for ${serverName}`,
      );
    }
    const mcp = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(mcp.mcpServers), ["inferredStdio", "inferredHttp"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP-only 插件的非法 auth shape 立即丢弃并生成明确 warning", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".zcode-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
    });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        text: { type: "http", url: "https://example.invalid/mcp", auth: "zcode_official" },
        array: {
          type: "http",
          url: "https://example.invalid/mcp",
          auth: [{ type: "zcode_official" }],
        },
        unknown: {
          type: "http",
          url: "https://example.invalid/mcp",
          auth: { type: "oauth" },
        },
        null: { type: "http", url: "https://example.invalid/mcp", auth: null },
      },
    });

    const result = await transpileFixture(dir);
    assert.equal(result.installation, "NOT_AVAILABLE");
    assert.match(result.unavailableReason ?? "", /MCP/);
    assert.deepEqual(result.components.mcpServers, []);
    for (const serverName of ["text", "array", "unknown", "null"]) {
      assert.ok(
        result.warnings.some((warning) => warning.includes(serverName)),
        `missing warning for ${serverName}`,
      );
    }
    const mcp = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(mcp.mcpServers), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ZCode UI 声明从 Codex manifest 移除并生成安装前可见 warning", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".claude-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
      ui: { surfaces: ["settings"] },
    });
    await mkdir(join(dir, "skills/demo"), { recursive: true });
    await writeFile(join(dir, "skills/demo/SKILL.md"), "x", "utf8");

    const result = await transpileFixture(dir);
    assert.equal(result.installation, "AVAILABLE");
    assert.ok(result.warnings.some((warning) => /UI surfaces.*unavailable/i.test(warning)));
    const manifest = JSON.parse(await readFile(join(dir, ".claude-plugin/plugin.json"), "utf8"));
    assert.equal(manifest.ui, undefined);
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

    const result = await transpileFixture(dir);
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
    await writeJson(dir, ".claude-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
    });
    await mkdir(join(dir, "skills/demo"), { recursive: true });
    await writeFile(
      join(dir, "skills/demo/SKILL.md"),
      "Use node_repl and the BrowserRecordingAPI to record.",
      "utf8",
    );
    const result = await transpileFixture(dir);
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
    const result = await transpileFixture(dir);
    assert.equal(result.installation, "NOT_AVAILABLE");
    assert.match(result.unavailableReason ?? "", /manifest/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const mismatch = await fixtureDir();
  try {
    await writeJson(mismatch, ".claude-plugin/plugin.json", {
      name: "demo",
      version: "9.9.9",
    });
    const result = await transpileFixture(mismatch);
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
    const result = await transpileFixture(channels);
    assert.equal(result.installation, "NOT_AVAILABLE");
    assert.match(result.unavailableReason ?? "", /channels/);
  } finally {
    await rm(channels, { recursive: true, force: true });
  }
});

test("an MCP-only plugin whose servers cannot be adapted is unavailable", async () => {
  const dir = await fixtureDir();
  try {
    await writeJson(dir, ".zcode-plugin/plugin.json", {
      name: "demo",
      version: "1.0.0",
    });
    await writeJson(dir, ".mcp.json", {
      mcpServers: {
        legacy: { type: "sse", url: "https://example.invalid/sse" },
        misconfigured: {
          type: "stdio",
          env: { TOKEN: "${user_config.missing}" },
          command: "x",
        },
      },
    });
    const result = await transpileFixture(dir);
    assert.equal(result.installation, "NOT_AVAILABLE");
    assert.match(result.unavailableReason ?? "", /MCP/);
    const mcp = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(mcp.mcpServers), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
