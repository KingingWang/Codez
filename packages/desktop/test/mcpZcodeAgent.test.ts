import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpSource, CliMcpSource } from "../src/mcp.js";
import {
  MCP_SOURCE_DESCRIPTORS,
  getSourceDescriptor,
} from "../src/main/mcpUserDirectory/types.js";
import {
  loadCliMcpFromUserDirectory,
  saveCliMcpToUserDirectory,
} from "../src/main/mcpUserDirectory/index.js";

const originalHome = process.env.HOME;
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codez-mcp-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  process.env.HOME = originalHome;
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("MCP Source Types", () => {
  it("应包含 codezagentmcp 类型", () => {
    const sources: McpSource[] = ["mcp", "codezagentmcp"];

    expect(sources).toContain("codezagentmcp");
  });

  it("codezagentmcp 应该是 CliMcpSource 类型", () => {
    const cliSource: CliMcpSource = "codezagentmcp";
    expect(cliSource).toBe("codezagentmcp");
  });
});

describe("MCP Source Descriptors", () => {
  it("只为 Codez Agent 提供描述符", () => {
    expect(MCP_SOURCE_DESCRIPTORS.map((descriptor) => descriptor.source)).toEqual(["codezagentmcp"]);
  });

  it("应能通过 getSourceDescriptor 获取 codezagentmcp 描述符", () => {
    const descriptor = getSourceDescriptor("codezagentmcp");

    expect(descriptor).toBeDefined();
    expect(descriptor.source).toBe("codezagentmcp");
    expect(descriptor.configDirSegments).toEqual([".codez", "cli"]);
    expect(descriptor.fileName).toBe("config.json");
    expect(descriptor.format).toBe("json");
    expect(descriptor.configKeyName).toBe("mcp.servers");
  });

  it("应为其他旧 provider source 抛出错误", () => {
    expect(() => getSourceDescriptor("claudeclimcp" as CliMcpSource)).toThrow("Unsupported MCP source");
    expect(() => getSourceDescriptor("geminiclimcp" as CliMcpSource)).toThrow("Unsupported MCP source");
    expect(() => getSourceDescriptor("codexclimcp" as CliMcpSource)).toThrow("Unsupported MCP source");
    expect(() => getSourceDescriptor("opencodemcp" as CliMcpSource)).toThrow("Unsupported MCP source");
  });

  it("应为无效 source 抛出错误", () => {
    expect(() =>
      getSourceDescriptor("invalid_source" as CliMcpSource)
    ).toThrow("Unsupported MCP source");
  });
});

describe("MCP 配置文件路径", () => {
  it("codezagentmcp 主配置文件应在 ~/.codez/cli/config.json", () => {
    const descriptor = getSourceDescriptor("codezagentmcp");

    expect(descriptor.configDirSegments).toEqual([".codez", "cli"]);
    expect(descriptor.fileName).toBe("config.json");
  });

  it("codezagentmcp 应使用 JSON 格式和 mcp.servers 键名", () => {
    const descriptor = getSourceDescriptor("codezagentmcp");

    expect(descriptor.format).toBe("json");
    expect(descriptor.configKeyName).toBe("mcp.servers");
  });
});

describe("MCP enabled state", () => {
  it("配置文件不可解析时应上抛，不能按空列表继续 replace", async () => {
    const home = makeTempRoot();
    process.env.HOME = home;
    mkdirSync(join(home, ".codez", "cli"), { recursive: true });
    writeFileSync(join(home, ".codez", "cli", "config.json"), "{ invalid json", "utf-8");

    await expect(loadCliMcpFromUserDirectory()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("prefers codez MCP config and skips agents/claude configs when codez has servers", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    process.env.HOME = home;
    mkdirSync(join(workspacePath, ".codez"), { recursive: true });
    mkdirSync(join(workspacePath, ".agents"), { recursive: true });
    mkdirSync(join(workspacePath, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codez", "cli"), { recursive: true });
    mkdirSync(join(home, ".agents"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(workspacePath, ".codez", "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            codezWorkspace: { command: "codez-workspace" },
          },
        },
      }),
      "utf-8",
    );
    writeFileSync(
      join(workspacePath, ".agents", "mcp.json"),
      JSON.stringify({ mcpServers: { agentsWorkspace: { command: "agents-workspace" } } }),
      "utf-8",
    );
    writeFileSync(
      join(workspacePath, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { claudeWorkspace: { command: "claude-workspace" } } }),
      "utf-8",
    );
    writeFileSync(
      join(home, ".codez", "cli", "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            codezUser: { command: "codez-user" },
          },
        },
      }),
      "utf-8",
    );
    writeFileSync(
      join(home, ".agents", "mcp.json"),
      JSON.stringify({ mcpServers: { agentsUser: { command: "agents-user" } } }),
      "utf-8",
    );
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { claudeUser: { command: "claude-user" } } }),
      "utf-8",
    );

    const result = await loadCliMcpFromUserDirectory({ workspacePath });

    expect(result.servers.map((server) => server.name)).toEqual(["codezWorkspace", "codezUser"]);
    expect(result.servers.map((server) => server.location?.source)).toEqual(["codez", "codez"]);
  });

  it("does not read claude MCP configs even when codez and agents configs are missing", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    process.env.HOME = home;
    mkdirSync(join(workspacePath, ".claude"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(workspacePath, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { claudeWorkspace: { command: "claude-workspace" } } }),
      "utf-8",
    );
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { claudeUser: { command: "claude-user" } } }),
      "utf-8",
    );

    const result = await loadCliMcpFromUserDirectory({ workspacePath });

    expect(result.servers).toEqual([]);
  });

  it("stores disabled servers on the original MCP server config", async () => {
    const home = makeTempRoot();
    const workspacePath = join(makeTempRoot(), "workspace");
    process.env.HOME = home;
    mkdirSync(join(workspacePath, ".agents"), { recursive: true });
    writeFileSync(
      join(workspacePath, ".agents", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          browser: { command: "npx", args: ["-y", "browser-mcp"] },
        },
      }),
      "utf-8",
    );

    const initial = await loadCliMcpFromUserDirectory({ workspacePath });
    const server = initial.servers.find((item) => item.name === "browser");
    expect(server).toEqual(expect.objectContaining({ enabled: true }));

    await saveCliMcpToUserDirectory({
      action: "set-enabled",
      source: "codezagentmcp",
      name: "browser",
      enabled: false,
      projectPath: workspacePath,
      location: server?.location,
    });

    const saved = JSON.parse(readFileSync(join(workspacePath, ".agents", "mcp.json"), "utf-8"));
    expect(saved.mcpServers.browser).toEqual({
      command: "npx",
      args: ["-y", "browser-mcp"],
      enabled: false,
    });

    const disabled = await loadCliMcpFromUserDirectory({ workspacePath });
    expect(disabled.servers.find((item) => item.name === "browser")).toEqual(
      expect.objectContaining({ enabled: false }),
    );

    await saveCliMcpToUserDirectory({
      action: "set-enabled",
      source: "codezagentmcp",
      name: "browser",
      enabled: true,
      projectPath: workspacePath,
      location: server?.location,
    });

    const reenabled = JSON.parse(readFileSync(join(workspacePath, ".agents", "mcp.json"), "utf-8"));
    expect(reenabled.mcpServers.browser).toEqual({
      command: "npx",
      args: ["-y", "browser-mcp"],
    });
  });

  it("cleans old directory override when writing codez MCP server enabled state", async () => {
    const home = makeTempRoot();
    process.env.HOME = home;
    mkdirSync(join(home, ".codez", "cli"), { recursive: true });
    writeFileSync(
      join(home, ".codez", "cli", "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            browser: { command: "npx", args: ["-y", "browser-mcp"] },
          },
          [join(home, ".codez", "cli")]: {
            browser: { enable: false },
          },
        },
      }),
      "utf-8",
    );

    const initial = await loadCliMcpFromUserDirectory();
    const server = initial.servers.find((item) => item.name === "browser");

    await saveCliMcpToUserDirectory({
      action: "set-enabled",
      source: "codezagentmcp",
      name: "browser",
      enabled: false,
      location: server?.location,
    });

    const saved = JSON.parse(readFileSync(join(home, ".codez", "cli", "config.json"), "utf-8"));
    expect(saved.mcp.servers.browser).toEqual({
      command: "npx",
      args: ["-y", "browser-mcp"],
      enabled: false,
    });
    expect(saved.mcp[join(home, ".codez", "cli")]).toBeUndefined();
  });

  it("reports a server disabled through enabled:false as disabled", async () => {
    const home = makeTempRoot();
    process.env.HOME = home;
    mkdirSync(join(home, ".codez", "cli"), { recursive: true });
    // 外部工具/手工编辑只写 enabled:false，桌面端也必须把它显示为已停用。
    writeFileSync(
      join(home, ".codez", "cli", "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            browser: { command: "npx", args: ["-y", "browser-mcp"], enabled: false },
          },
        },
      }),
      "utf-8",
    );

    const loaded = await loadCliMcpFromUserDirectory();

    expect(loaded.servers.find((item) => item.name === "browser")).toEqual(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("overwrites a stale enabled:true flag when disabling a server", async () => {
    const home = makeTempRoot();
    process.env.HOME = home;
    mkdirSync(join(home, ".codez", "cli"), { recursive: true });
    // 复现线上配置：同一条 server 同时带 enable 与 enabled，停用后不能留下自相矛盾的字段。
    writeFileSync(
      join(home, ".codez", "cli", "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            browser: { command: "npx", args: ["-y", "browser-mcp"], enabled: true },
          },
        },
      }),
      "utf-8",
    );

    const initial = await loadCliMcpFromUserDirectory();
    const server = initial.servers.find((item) => item.name === "browser");

    await saveCliMcpToUserDirectory({
      action: "set-enabled",
      source: "codezagentmcp",
      name: "browser",
      enabled: false,
      location: server?.location,
    });

    const saved = JSON.parse(readFileSync(join(home, ".codez", "cli", "config.json"), "utf-8"));
    expect(saved.mcp.servers.browser).toEqual({
      command: "npx",
      args: ["-y", "browser-mcp"],
      enabled: false,
    });
  });

  it("migrates a legacy enable flag to enabled on load", async () => {
    const home = makeTempRoot();
    process.env.HOME = home;
    mkdirSync(join(home, ".codez", "cli"), { recursive: true });
    // 存量配置只有桌面端历史写入的 enable；加载时应就地迁移成契约字段 enabled。
    writeFileSync(
      join(home, ".codez", "cli", "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            browser: { command: "npx", args: ["-y", "browser-mcp"], enable: false },
          },
        },
      }),
      "utf-8",
    );

    const loaded = await loadCliMcpFromUserDirectory();

    expect(loaded.servers.find((item) => item.name === "browser")).toEqual(
      expect.objectContaining({ enabled: false }),
    );
    const saved = JSON.parse(readFileSync(join(home, ".codez", "cli", "config.json"), "utf-8"));
    expect(saved.mcp.servers.browser).toEqual({
      command: "npx",
      args: ["-y", "browser-mcp"],
      enabled: false,
    });
  });

  it("keeps a server disabled when legacy enable:false collides with enabled:true", async () => {
    const home = makeTempRoot();
    process.env.HOME = home;
    mkdirSync(join(home, ".codez", "cli"), { recursive: true });
    // 线上事故配置：停用写了 enable:false，但外部导入残留 enabled:true。迁移必须保住停用语义。
    writeFileSync(
      join(home, ".codez", "cli", "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            browser: {
              command: "npx",
              args: ["-y", "browser-mcp"],
              enable: false,
              enabled: true,
            },
          },
        },
      }),
      "utf-8",
    );

    const loaded = await loadCliMcpFromUserDirectory();

    expect(loaded.servers.find((item) => item.name === "browser")).toEqual(
      expect.objectContaining({ enabled: false }),
    );
    const saved = JSON.parse(readFileSync(join(home, ".codez", "cli", "config.json"), "utf-8"));
    expect(saved.mcp.servers.browser).toEqual({
      command: "npx",
      args: ["-y", "browser-mcp"],
      enabled: false,
    });
  });

  it("leaves the config file byte-identical when no legacy enable flag exists", async () => {
    const home = makeTempRoot();
    process.env.HOME = home;
    mkdirSync(join(home, ".codez", "cli"), { recursive: true });
    // 迁移必须幂等：没有残留字段时不能重写文件，否则每次加载都会动用户的配置。
    const raw = JSON.stringify({
      mcp: {
        servers: {
          browser: { command: "npx", args: ["-y", "browser-mcp"], enabled: false },
        },
      },
    });
    writeFileSync(join(home, ".codez", "cli", "config.json"), raw, "utf-8");

    await loadCliMcpFromUserDirectory();

    expect(readFileSync(join(home, ".codez", "cli", "config.json"), "utf-8")).toBe(raw);
  });

  it("clears a stale enabled:false flag when re-enabling a server", async () => {
    const home = makeTempRoot();
    process.env.HOME = home;
    mkdirSync(join(home, ".codez", "cli"), { recursive: true });
    writeFileSync(
      join(home, ".codez", "cli", "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            browser: { command: "npx", args: ["-y", "browser-mcp"], enabled: false },
          },
        },
      }),
      "utf-8",
    );

    const initial = await loadCliMcpFromUserDirectory();
    const server = initial.servers.find((item) => item.name === "browser");

    await saveCliMcpToUserDirectory({
      action: "set-enabled",
      source: "codezagentmcp",
      name: "browser",
      enabled: true,
      location: server?.location,
    });

    const saved = JSON.parse(readFileSync(join(home, ".codez", "cli", "config.json"), "utf-8"));
    expect(saved.mcp.servers.browser).toEqual({
      command: "npx",
      args: ["-y", "browser-mcp"],
    });
  });
});
