import { describe, expect, it } from "vitest";
import type { CodezMcpServer } from "@codez/shared";
import {
  SOURCE_META,
  MCP_SECTIONS,
  serverToForm,
  formToConfig,
  formToJsonDraft,
  jsonDraftToForm,
  type FormState,
} from "../src/settings/mcpSettingsShared.js";

describe("MCP Settings Shared", () => {
  describe("SOURCE_META", () => {
    it("应包含 codezagentmcp 的元数据", () => {
      expect(SOURCE_META.codezagentmcp).toBeDefined();
      expect(SOURCE_META.codezagentmcp.label).toBe("Codez Agent");
      expect(SOURCE_META.codezagentmcp.section).toBe("Codez Agent");
      expect(SOURCE_META.codezagentmcp.badgeClass).toContain("cyan");
    });
  });

  describe("MCP_SECTIONS", () => {
    it("只展示 Codez Agent MCP scope", () => {
      expect(MCP_SECTIONS).toEqual(["codezagentmcp"]);
      expect([...MCP_SECTIONS]).not.toContain("codexclimcp");
      expect([...MCP_SECTIONS]).not.toContain("geminiclimcp");
      expect([...MCP_SECTIONS]).not.toContain("opencodemcp");
    });
  });

  describe("serverToForm", () => {
    it("应正确转换 streamableHttp 类型", () => {
      const server: CodezMcpServer = {
        id: "test-id",
        name: "test-server",
        source: "codezagentmcp",
        scope: "user",
        enabled: true,
        config: {
          type: "streamableHttp",
          url: "https://example.com/mcp",
        },
      };

      const form = serverToForm(server);

      expect(form.type).toBe("streamableHttp");
      expect(form.url).toBe("https://example.com/mcp");
      expect(form.storageLevel).toBe("user");
    });

    it("应正确转换 workspace scope", () => {
      const server: CodezMcpServer = {
        id: "test-id",
        name: "test-server",
        source: "codezagentmcp",
        scope: "workspace",
        projectPath: "/workspace",
        enabled: true,
        config: {
          type: "http",
          url: "https://example.com/mcp",
        },
      };

      expect(serverToForm(server).storageLevel).toBe("workspace");
    });

    it("应正确转换 http 类型", () => {
      const server: CodezMcpServer = {
        id: "test-id",
        name: "test-server",
        source: "codezagentmcp",
        scope: "user",
        enabled: true,
        config: {
          type: "http",
          url: "https://example.com/mcp",
        },
      };

      const form = serverToForm(server);

      expect(form.type).toBe("http");
      expect(form.url).toBe("https://example.com/mcp");
    });

    it("应正确转换 sse 类型", () => {
      const server: CodezMcpServer = {
        id: "test-id",
        name: "test-server",
        source: "codezagentmcp",
        scope: "user",
        enabled: true,
        config: {
          type: "sse",
          url: "https://example.com/mcp/sse",
        },
      };

      const form = serverToForm(server);

      expect(form.type).toBe("sse");
      expect(form.url).toBe("https://example.com/mcp/sse");
    });

    it("应正确转换 stdio 类型", () => {
      const server: CodezMcpServer = {
        id: "test-id",
        name: "test-server",
        source: "codezagentmcp",
        scope: "user",
        enabled: true,
        config: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-memory"],
        },
      };

      const form = serverToForm(server);

      expect(form.type).toBe("stdio");
      expect(form.command).toBe("npx");
      expect(form.args).toBe("-y @modelcontextprotocol/server-memory");
    });

    it("应保留 MCP timeoutMs", () => {
      const server: CodezMcpServer = {
        id: "test-id",
        name: "test-server",
        source: "codezagentmcp",
        scope: "user",
        enabled: true,
        config: {
          type: "stdio",
          command: "node",
          timeoutMs: 800,
        },
      };

      expect(serverToForm(server).timeoutMs).toBe("800");
    });
  });

  describe("formToConfig", () => {
    it("应正确转换 streamableHttp 表单", () => {
      const form: FormState = {
        name: "test-server",
        scope: "codezagentmcp",
        storageLevel: "user",
        type: "streamableHttp",
        command: "",
        args: "",
        env: "",
        url: "https://example.com/mcp",
        headers: '{"Authorization": "Bearer token"}',
        timeoutMs: "",
      };

      const config = formToConfig(form);

      expect(config.type).toBe("streamableHttp");
      expect(config.url).toBe("https://example.com/mcp");
      expect(config.headers).toEqual({ Authorization: "Bearer token" });
    });

    it("应正确转换 http 表单", () => {
      const form: FormState = {
        name: "test-server",
        scope: "codezagentmcp",
        storageLevel: "user",
        type: "http",
        command: "",
        args: "",
        env: "",
        url: "https://example.com/mcp",
        headers: "",
        timeoutMs: "",
      };

      const config = formToConfig(form);

      expect(config.type).toBe("http");
      expect(config.url).toBe("https://example.com/mcp");
    });

    it("应正确转换 sse 表单", () => {
      const form: FormState = {
        name: "test-server",
        scope: "codezagentmcp",
        storageLevel: "user",
        type: "sse",
        command: "",
        args: "",
        env: "",
        url: "https://example.com/mcp/sse",
        headers: "",
        timeoutMs: "",
      };

      const config = formToConfig(form);

      expect(config.type).toBe("sse");
      expect(config.url).toBe("https://example.com/mcp/sse");
    });

    it("应正确转换 stdio 表单", () => {
      const form: FormState = {
        name: "test-server",
        scope: "codezagentmcp",
        storageLevel: "user",
        type: "stdio",
        command: "npx",
        args: "-y @modelcontextprotocol/server-memory",
        env: '{"API_KEY": "test"}',
        url: "",
        headers: "",
        timeoutMs: "800",
      };

      const config = formToConfig(form);

      expect(config.type).toBe("stdio");
      expect(config.command).toBe("npx");
      expect(config.args).toEqual(["-y", "@modelcontextprotocol/server-memory"]);
      expect(config.env).toEqual({ API_KEY: "test" });
      expect(config.timeoutMs).toBe(800);
    });

    it("应忽略无效 timeoutMs", () => {
      const form: FormState = {
        name: "test-server",
        scope: "codezagentmcp",
        storageLevel: "user",
        type: "http",
        command: "",
        args: "",
        env: "",
        url: "https://example.com/mcp",
        headers: "",
        timeoutMs: "0",
      };

      expect(formToConfig(form)).not.toHaveProperty("timeoutMs");
    });
  });

  describe("JSON 编辑模式", () => {
    it("从 JSON 粘贴 MCP server 时应保留 timeoutMs", () => {
      const form = jsonDraftToForm(
        JSON.stringify({
          slow: {
            type: "stdio",
            command: "node",
            args: ["/tmp/slow-server.mjs"],
            timeoutMs: 800,
          },
        }),
        {
          name: "",
          scope: "codezagentmcp",
          storageLevel: "user",
          type: "stdio",
          command: "",
          args: "",
          env: "",
          url: "",
          headers: "",
          timeoutMs: "",
        },
      );

      expect(form.timeoutMs).toBe("800");
      expect(formToConfig(form)).toMatchObject({ timeoutMs: 800 });
    });

    it("从 JSON 粘贴 MCP server 时应保留 oauth", () => {
      const form = jsonDraftToForm(
        JSON.stringify({
          notion: {
            type: "http",
            url: "https://mcp.notion.com/mcp",
            oauth: {
              type: "authorization_code",
              clientName: "Codez Notion MCP",
            },
          },
        }),
        {
          name: "",
          scope: "codezagentmcp",
          storageLevel: "user",
          type: "http",
          command: "",
          args: "",
          env: "",
          url: "",
          headers: "",
          timeoutMs: "",
        },
      );

      expect(form.oauth).toContain("authorization_code");
      expect(formToConfig(form)).toMatchObject({
        oauth: {
          type: "authorization_code",
          clientName: "Codez Notion MCP",
        },
      });
    });

    it("全新 HTTP URL 配置不应自动写入 OAuth 草稿", () => {
      const draft = formToJsonDraft({
        name: "notion",
        scope: "codezagentmcp",
        storageLevel: "user",
        type: "http",
        command: "",
        args: "",
        env: "",
        url: "https://mcp.notion.com/mcp",
        headers: "",
        timeoutMs: "30000",
      });

      expect(JSON.parse(draft)).toMatchObject({
        notion: {
          type: "http",
          url: "https://mcp.notion.com/mcp",
          timeoutMs: 30000,
        },
      });
      expect(JSON.parse(draft).notion.oauth).toBeUndefined();
    });

    it("从表单生成 JSON 草稿时应写出 timeoutMs", () => {
      const draft = formToJsonDraft({
        name: "slow",
        scope: "codezagentmcp",
        storageLevel: "user",
        type: "stdio",
        command: "node",
        args: "/tmp/slow-server.mjs",
        env: "",
        url: "",
        headers: "",
        timeoutMs: "800",
      });

      expect(JSON.parse(draft)).toMatchObject({
        slow: {
          timeoutMs: 800,
        },
      });
    });
  });

  describe("FormState 类型", () => {
    it("应支持所有传输类型", () => {
      const validTypes: FormState["type"][] = [
        "stdio",
        "http",
        "sse",
        "streamableHttp",
      ];

      expect(validTypes).toHaveLength(4);
      expect(validTypes).toContain("streamableHttp");
    });
  });
});
