import type { Logger, PluginLoadOutcome } from "@codez/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolverCapture = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../src/plugins.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/plugins.js")>();
  return {
    ...actual,
    resolveCodezPlugins(options: Record<string, unknown>): PluginLoadOutcome {
      resolverCapture.options = options;
      return {
        commandRoots: [],
        diagnostics: [],
        hookRegistrations: [],
        mcpServers: {},
        plugins: [],
        skillRoots: [],
      };
    },
  };
});

import { listPlugins } from "../src/codez-protocol/plugins.js";
import type { CodezProtocolAgentServerContext } from "../src/codez-protocol/server-types.js";

describe("plugins protocol logger propagation", () => {
  beforeEach(() => {
    resolverCapture.options = undefined;
  });

  it("forwards the protocol logger to degraded plugin cache handling", async () => {
    const logger = createLogger();

    await listPlugins({ logger } as CodezProtocolAgentServerContext, {
      workspace: { workspaceKey: "/workspace", workspacePath: "/workspace" },
    });

    expect(resolverCapture.options).toMatchObject({ logger });
  });
});

function createLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return logger;
}
