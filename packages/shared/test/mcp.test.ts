import { describe, expect, it } from "vitest";
import {
  convertToCodezAgentMcpServer,
  isCodezCuaMcpCommand,
  isCodezCuaMcpPackageArg,
} from "../src/mcp.js";

describe("codez-cua MCP matcher (single source of truth for services + CLI bootstrap)", () => {
  it("matches the codez-cua command by leaf name", () => {
    expect(isCodezCuaMcpCommand("codez-cua")).toBe(true);
    expect(isCodezCuaMcpCommand("/opt/homebrew/bin/codez-cua")).toBe(true);
    expect(isCodezCuaMcpCommand("uvx")).toBe(false);
    expect(isCodezCuaMcpCommand("codez-cua-server")).toBe(false);
  });

  it("matches uvx/pip package spec forms", () => {
    for (const arg of ["codez-cua", "codez-cua[macos]", "codez-cua@v0.1.3", "codez-cua[macos]@v0.1.3"]) {
      expect(isCodezCuaMcpPackageArg(arg)).toBe(true);
    }
  });

  it("matches git and local-path forms (the drift that broke desktop/services parity)", () => {
    expect(isCodezCuaMcpPackageArg("codez-cua.git")).toBe(true);
    expect(isCodezCuaMcpPackageArg("git+https://github.com/x/codez-cua.git@v0.1.3")).toBe(true);
    expect(isCodezCuaMcpPackageArg("/Users/me/src/codez-cua")).toBe(true);
    expect(isCodezCuaMcpPackageArg("C:\\src\\codez-cua")).toBe(true);
  });

  it("does not match unrelated args", () => {
    for (const arg of ["--from", "run", "codez-cua-server", "not-codez-cua", "server.js"]) {
      expect(isCodezCuaMcpPackageArg(arg)).toBe(false);
    }
  });

  it("recognizes a package spec placed in COMMAND position (command/arg matchers stay consistent)", () => {
    // 之前 command matcher 只认精确叶子 codez-cua，会漏判把包规格直接当 command 的配置 → 漏注入 broker。
    for (const command of ["codez-cua@1.2.3", "codez-cua[macos]", "codez-cua.git", "/opt/tools/codez-cua@1.2.3"]) {
      expect(isCodezCuaMcpCommand(command), command).toBe(true);
    }
  });

  it("recognizes pip == pins and the codez_cua underscore distribution name (PyPI treats _ == -)", () => {
    for (const arg of ["codez-cua==1.2.3", "codez_cua", "codez_cua==1.2.3", "codez_cua@v0.1.3"]) {
      expect(isCodezCuaMcpPackageArg(arg), arg).toBe(true);
    }
    expect(isCodezCuaMcpCommand("codez_cua")).toBe(true);
  });

  it("does not false-positive on sibling packages like codez-cua-proxy", () => {
    for (const value of ["codez-cua-proxy", "codez-cua-proxy@1.0.0", "codez-cua-helper"]) {
      expect(isCodezCuaMcpCommand(value), value).toBe(false);
      expect(isCodezCuaMcpPackageArg(value), value).toBe(false);
    }
  });

  it("recognizes `python -m codez_cua.server` submodule form (M1 fail-open fix)", () => {
    // `python -m codez_cua.server` → arg 是 `codez_cua.server`；旧 matcher 漏判 → 不注入 broker → fail-open。
    for (const arg of ["codez_cua.server", "codez-cua.server", "codez_cua.main", "codez-cua.__main__"]) {
      expect(isCodezCuaMcpPackageArg(arg), arg).toBe(true);
    }
  });

  it("recognizes local paths with a trailing separator (M1 fail-open fix)", () => {
    // `.../codez-cua/` 直接取叶子会得到空串 → 漏判 → fail-open。
    expect(isCodezCuaMcpPackageArg("/Users/me/src/codez-cua/")).toBe(true);
    expect(isCodezCuaMcpPackageArg("C:\\src\\codez-cua\\")).toBe(true);
    expect(isCodezCuaMcpCommand("/opt/homebrew/bin/codez-cua/")).toBe(true);
    // 但带尾斜杠的 sibling 仍不误判。
    expect(isCodezCuaMcpPackageArg("/Users/me/src/codez-cua-proxy/")).toBe(false);
  });
});

describe("MCP config helpers", () => {
  it("passes legacy http_headers through to Codez Agent MCP servers", () => {
    expect(
      convertToCodezAgentMcpServer("web-search-prime", {
        type: "http",
        url: "https://bigmodel.example.test/mcp",
        timeoutMs: 5000,
        http_headers: {
          Authorization: "Bearer token",
        },
      }),
    ).toEqual({
      name: "web-search-prime",
      type: "http",
      url: "https://bigmodel.example.test/mcp",
      headers: [{ name: "Authorization", value: "Bearer token" }],
      timeoutMs: 5000,
    });
  });

  it("preserves timeoutMs when converting stdio MCP servers for Codez Agent", () => {
    expect(
      convertToCodezAgentMcpServer("context7", {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        timeoutMs: 3,
      }),
    ).toEqual({
      name: "context7",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: [],
      timeoutMs: 3,
    });
  });

  it("preserves timeoutMs when converting sse MCP servers for Codez Agent", () => {
    expect(
      convertToCodezAgentMcpServer("stream", {
        type: "sse",
        url: "https://bigmodel.example.test/sse",
        timeoutMs: 8000,
      }),
    ).toEqual({
      name: "stream",
      type: "sse",
      url: "https://bigmodel.example.test/sse",
      headers: [],
      timeoutMs: 8000,
    });
  });

  it("preserves HTTP OAuth client credentials when converting MCP servers for Codez Agent", () => {
    expect(
      convertToCodezAgentMcpServer("protected", {
        type: "http",
        url: "https://mcp.example.test/mcp",
        oauth: {
          type: "client_credentials",
          clientId: "codez-client",
          clientSecret: "secret",
          scope: "mcp:tools",
        },
      }),
    ).toMatchObject({
      name: "protected",
      type: "http",
      oauth: {
        type: "client_credentials",
        clientId: "codez-client",
        clientSecret: "secret",
        scope: "mcp:tools",
      },
    });
  });

  it("preserves HTTP OAuth authorization code config when converting MCP servers for Codez Agent", () => {
    expect(
      convertToCodezAgentMcpServer("figma", {
        type: "http",
        url: "https://mcp.figma.com/mcp",
        oauth: {
          type: "authorization_code",
          clientName: "Codez",
          redirectPath: "/oauth/callback/mcp/figma",
          scope: "mcp:connect",
        },
      }),
    ).toMatchObject({
      name: "figma",
      type: "http",
      oauth: {
        type: "authorization_code",
        clientName: "Codez",
        redirectPath: "/oauth/callback/mcp/figma",
        scope: "mcp:connect",
      },
    });
  });

  it("does not persist implicit OAuth defaults when converting bare HTTP MCP servers", () => {
    expect(
      convertToCodezAgentMcpServer("notion", {
        type: "http",
        url: "https://mcp.notion.com/mcp",
        timeoutMs: 30000,
      }),
    ).toEqual({
      name: "notion",
      type: "http",
      url: "https://mcp.notion.com/mcp",
      headers: [],
      timeoutMs: 30000,
    });
  });

  it("drops invalid timeoutMs when converting MCP servers for Codez Agent", () => {
    expect(
      convertToCodezAgentMcpServer("zero", {
        type: "stdio",
        command: "npx",
        timeoutMs: 0,
      }),
    ).not.toHaveProperty("timeoutMs");

    expect(
      convertToCodezAgentMcpServer("fractional", {
        type: "http",
        url: "https://bigmodel.example.test/mcp",
        timeoutMs: 1.5,
      }),
    ).not.toHaveProperty("timeoutMs");
  });

  it("keeps headers ahead of legacy http_headers when both are present", () => {
    expect(
      convertToCodezAgentMcpServer("web-reader", {
        type: "sse",
        url: "https://bigmodel.example.test/sse",
        headers: {
          Authorization: "Bearer fresh",
        },
        http_headers: {
          Authorization: "Bearer stale",
        },
      }),
    ).toMatchObject({
      headers: [{ name: "Authorization", value: "Bearer fresh" }],
    });
  });
});
