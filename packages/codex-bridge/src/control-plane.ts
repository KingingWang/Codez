import { z } from "zod";
import * as s from "@zcode/shared";
import type { BridgeControlContext } from "./contract.js";
import { checkWorkspace, ControlError, input, unsupported } from "./control-common.js";
import { readControlPresentation, readControlSkills } from "./control-presentation.js";
import { readControlMcp } from "./control-mcp.js";
import { handlePluginRequest } from "./control-plugins.js";

const methods = new Set([
  "runtime/capabilities",
  "workspace/readPresentation",
  "skills/referenceCatalog",
  "mcp/list",
  "provider/updateAccountConfig",
  "workspace/updateInteractionPreferences",
  "workspace/updateModelIoPreferences",
  "workspace/generateText",
  "workspace/cancelGenerateText",
  "plugins/list",
  "plugins/overview",
  "plugins/referenceCatalog",
  "plugins/referenceCatalogWithCategory",
  "plugins/describe",
  "plugins/setEnabled",
  "plugins/install",
  "plugins/uninstall",
  "plugins/marketplace/add",
  "plugins/marketplace/remove",
  "plugins/marketplace/update",
]);

/** Dispatch ownership, not a promise that every parameter combination is supported. */
export function supportsControlMethod(method: string): boolean {
  return methods.has(method);
}

/** Unknown/unsupported mutations reject with JSON-RPC code, message and structured data. */
export async function handleControlRequest(
  method: string,
  params: unknown,
  context: BridgeControlContext,
): Promise<unknown> {
  try {
    return await dispatch(method, params, context);
  } catch (error) {
    if (error instanceof ControlError) throw error;
    // 上游 RPC 错误保留原 code；禁止把失败投影成空列表或成功回执，也不重试写操作。
    if (error && typeof error === "object" && "code" in error && typeof error.code === "number")
      throw error;
    throw new ControlError(
      -32000,
      error instanceof z.ZodError
        ? "Invalid Codex control-plane response"
        : error instanceof Error
          ? error.message
          : "Codex control-plane failure",
      {
        method,
        reason: error instanceof z.ZodError ? "invalid_upstream_response" : "upstream_failure",
      },
    );
  }
}

async function dispatch(
  method: string,
  params: unknown,
  context: BridgeControlContext,
): Promise<unknown> {
  if (method.startsWith("plugins/")) return handlePluginRequest(method, params, context);
  switch (method) {
    case "runtime/capabilities":
      input(z.object({}).strict(), params ?? {}, method);
      return s.zcodeRuntimeCapabilitiesSchema.parse({ independentPlanState: true });
    case "workspace/readPresentation": {
      const p = input(s.zcodeWorkspaceReadPresentationParamsSchema, params, method);
      checkWorkspace(p.workspace, context, method);
      return readControlPresentation(p.workspace, context);
    }
    case "skills/referenceCatalog": {
      const p = input(s.zcodeSkillsReferenceCatalogParamsSchema, params, method);
      checkWorkspace(p.workspace, context, method);
      if (p.sessionId) unsupported(method, "Codex does not expose a frozen session skill catalog");
      return readControlSkills(context);
    }
    case "mcp/list": {
      const p = input(s.zcodeMcpListParamsSchema, params, method);
      checkWorkspace(p.workspace, context, method);
      if (p.mcpServers?.length)
        unsupported(
          method,
          "Codex owns MCP configuration; ZCode server overlays cannot be applied",
        );
      return readControlMcp(context);
    }
    case "provider/updateAccountConfig": {
      const p = input(s.zcodeProviderUpdateAccountConfigParamsSchema, params, method);
      // 只确认旧 Host 同步信封已收到；0 表示未注册任何 ZCode provider，不能覆盖 Codex 凭据。
      return s.zcodeProviderUpdateAccountConfigResultSchema.parse({
        receivedRevision: p.revision,
        providerCount: 0,
        status: "received",
      });
    }
    case "workspace/updateInteractionPreferences": {
      const p = input(s.zcodeWorkspaceUpdateInteractionPreferencesParamsSchema, params, method);
      checkWorkspace(p.workspace, context, method);
      if (p.preferences.askUserQuestionAutoResolutionEnabled)
        unsupported(method, "Codex questions require explicit user answers");
      return s.zcodeWorkspaceUpdateInteractionPreferencesResultSchema.parse({
        workspace: p.workspace,
        askUserQuestionAutoResolutionEnabled: false,
        snoozedInteractionCount: 0,
      });
    }
    case "workspace/updateModelIoPreferences": {
      const p = input(s.zcodeWorkspaceUpdateModelIoPreferencesParamsSchema, params, method);
      checkWorkspace(p.workspace, context, method);
      if (p.preferences.fullRetentionEnabled)
        unsupported(method, "ZCode full model-I/O retention is not implemented for Codex");
      return s.zcodeWorkspaceUpdateModelIoPreferencesResultSchema.parse({
        workspace: p.workspace,
        fullRetentionEnabled: false,
        updatedSessionCount: 0,
      });
    }
    case "workspace/generateText": {
      const p = input(s.zcodeWorkspaceGenerateTextParamsSchema, params, method);
      checkWorkspace(p.workspace, context, method);
      // RPC port 无事件订阅，ephemeral thread 又不支持 includeTurns；不能开始一个无法收尾或取消的生成。
      return unsupported(
        method,
        "Restricted ephemeral generation requires turn events and cancellation lifecycle support on the bridge port",
      );
    }
    case "workspace/cancelGenerateText":
      input(s.zcodeWorkspaceCancelGenerateTextParamsSchema, params, method);
      return unsupported(method, "Auxiliary generation is unavailable; no operation was started");
    default:
      return unsupported(method, "No Codex control-plane mapping");
  }
}
