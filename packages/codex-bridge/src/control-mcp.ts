import { z } from "zod";
import { codezMcpListResultSchema, type CodezMcpServerStatusSnapshot } from "@codez/shared";
import type { BridgeControlContext } from "./contract.js";
import { readConfig, readPages, unsupported } from "./control-common.js";

const statusSchema = z.object({
  name: z.string().min(1),
  tools: z.record(z.string(), z.unknown()),
  toolsError: z.string().nullable(),
  runtimeStatus: z
    .enum([
      "notStarted",
      "starting",
      "connected",
      "authenticationRequired",
      "failed",
      "cancelled",
      "disabled",
    ])
    .nullable(),
});

export async function readControlMcp(context: BridgeControlContext) {
  const [config, servers] = await Promise.all([
    readConfig(context),
    readPages(context, "mcpServerStatus/list", statusSchema, { detail: "toolsAndAuthOnly" }),
  ]);
  const statuses: Record<string, CodezMcpServerStatusSnapshot> = {};
  for (const server of servers) {
    const configured = config.mcp_servers?.[server.name];
    const transport = configured?.command ? "stdio" : configured?.url ? "http" : undefined;
    if (!transport) unsupported("mcp/list", `Codex did not expose transport for ${server.name}`);
    const status =
      configured?.enabled === false || server.runtimeStatus === "disabled"
        ? "disabled"
        : server.toolsError ||
            server.runtimeStatus === "failed" ||
            server.runtimeStatus === "authenticationRequired"
          ? "failed"
          : server.runtimeStatus === "connected"
            ? "connected"
            : server.runtimeStatus === "starting"
              ? "connecting"
              : "disconnected";
    statuses[server.name] = {
      status,
      transport,
      toolCount: Object.keys(server.tools).length,
      updatedAt: new Date().toISOString(),
      ...(server.toolsError
        ? { error: server.toolsError, failureKind: "tool_list_failed" as const }
        : {}),
      ...(server.runtimeStatus === "authenticationRequired"
        ? { failureKind: "not_authenticated" as const }
        : {}),
      ...(server.runtimeStatus === null ? { failureKind: "status_unavailable" as const } : {}),
    };
  }
  return codezMcpListResultSchema.parse({ statuses });
}
