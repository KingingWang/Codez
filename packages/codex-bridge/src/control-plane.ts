import { z } from "zod";
import * as s from "@codez/shared";
import type { BridgeControlContext } from "./contract.js";
import { checkWorkspace, ControlError, input, readPages, unsupported } from "./control-common.js";
import { readControlPresentation, readControlSkills } from "./control-presentation.js";
import { readControlMcp, writeProjectMcpConfig } from "./control-mcp.js";
import { handlePluginRequest } from "./control-plugins.js";
import { handleAgentRequest } from "./control-agents.js";
import { handleCatalogRequest } from "./control-catalog.js";

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
  "plugins/update",
  "plugins/uninstall",
  "plugins/marketplace/add",
  "plugins/marketplace/remove",
  "plugins/marketplace/update",
  "agents/list",
  "agents/write",
  "agents/delete",
  "mcp/projectConfigWrite",
  "catalog/read",
  "catalog/readModels",
  "catalog/writeModel",
  "catalog/deleteModel",
]);

/** Dispatch ownership, not a promise that every parameter combination is supported. */
export function supportsControlMethod(method: string): boolean {
  return methods.has(method);
}

/**
 * Bridge dispatch authority. The auxiliary port owns generation support; this module only
 * receives control-plane dispatch. Keeping this fact explicit prevents Host/UI from probing
 * methods or parsing failures to build a second capability matrix.
 */
export function bridgeCodexFeatureCapabilities(
  auxiliary: {
    supports(method: string): boolean;
  },
  nativeBrowserCua?: {
    browserAvailable: boolean;
    cuaAvailable: boolean;
  },
  autoReviewApprovals?: "supported" | "unsupported",
): s.CodexFeatureCapabilities {
  let nativeBrowserCuaMcp: s.CodexFeatureCapabilities["nativeBrowserCuaMcp"] = "unsupported";
  if (nativeBrowserCua?.browserAvailable === true) {
    nativeBrowserCuaMcp = nativeBrowserCua.cuaAvailable === true ? "supported" : "degraded";
  }
  return {
    auxiliaryTextGeneration: auxiliary.supports("workspace/generateText")
      ? "supported"
      : "unsupported",
    observedSessionUsage: "supported",
    observedAppUsage: "supported",
    sharedContextContentCopy: "degraded",
    scheduledPromptAutomations: "supported",
    nativeBrowserCuaMcp,
    readOnlyWorkflowHistory: "supported",
    safeDesktopFileRewind: "supported",
    legacyWorkflowRuns: "unsupported",
    // 缺省即 unsupported（与旧 peer 缺省字段的解析一致）；只有探测成功才宣告。
    autoReviewApprovals: autoReviewApprovals ?? "unsupported",
  };
}

/**
 * Approve-for-me（approvalsReviewer:"auto_review"）能力探测（specs/codex-permission-modes.md）：
 * 原生 guardian_approval feature 已启用，且组织策略未把审批人白名单排除 auto_review。
 * 探测失败或旧原生缺失该 feature 一律 fail-closed（unsupported），不猜测可用。
 */
async function probeAutoReviewApprovals(
  context: BridgeControlContext,
): Promise<"supported" | "unsupported"> {
  try {
    const features = await readPages(
      context,
      "experimentalFeature/list",
      z.object({ name: z.string(), enabled: z.boolean() }),
    );
    if (!features.some((feature) => feature.name === "guardian_approval" && feature.enabled))
      return "unsupported";
    const { requirements } = z
      .object({
        requirements: z
          .object({ allowedApprovalsReviewers: z.array(z.string()).nullable().optional() })
          .nullable()
          .optional(),
      })
      .parse(await context.rpc.request("configRequirements/read"));
    const allowed = requirements?.allowedApprovalsReviewers;
    // 无 requirements 或白名单缺省 = 不限制；显式白名单必须包含 auto_review
    //（guardian_subagent 是 auto_review 的旧别名，等价对待）。
    return !allowed ||
      allowed.some((value) => value === "auto_review" || value === "guardian_subagent")
      ? "supported"
      : "unsupported";
  } catch {
    return "unsupported";
  }
}

/** 探测结果按 bridge 进程缓存（spec：能力探测与降级）；同一 rpc 端口只探测一次。 */
const autoReviewProbes = new WeakMap<object, Promise<"supported" | "unsupported">>();

function detectAutoReviewApprovals(
  context: BridgeControlContext,
): Promise<"supported" | "unsupported"> {
  const cached = autoReviewProbes.get(context.rpc);
  if (cached) return cached;
  const probe = probeAutoReviewApprovals(context);
  autoReviewProbes.set(context.rpc, probe);
  return probe;
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
  if (method.startsWith("agents/")) return handleAgentRequest(method, params, context);
  if (method.startsWith("catalog/")) return handleCatalogRequest(method, params, context);
  switch (method) {
    case "runtime/capabilities":
      input(z.object({}).strict(), params ?? {}, method);
      return s.codezRuntimeCapabilitiesSchema.parse({
        independentPlanState: true,
        codex: bridgeCodexFeatureCapabilities(
          context.auxiliary ?? { supports: () => false },
          context.nativeBrowserCua,
          await detectAutoReviewApprovals(context),
        ),
      });
    case "workspace/readPresentation": {
      const p = input(s.codezWorkspaceReadPresentationParamsSchema, params, method);
      checkWorkspace(p.workspace, context, method);
      return readControlPresentation(p.workspace, context);
    }
    case "skills/referenceCatalog": {
      const p = input(s.codezSkillsReferenceCatalogParamsSchema, params, method);
      checkWorkspace(p.workspace, context, method);
      if (p.sessionId) unsupported(method, "Codex does not expose a frozen session skill catalog");
      return readControlSkills(context);
    }
    case "mcp/list": {
      const p = input(s.codezMcpListParamsSchema, params, method);
      checkWorkspace(p.workspace, context, method);
      if (p.mcpServers?.length)
        unsupported(
          method,
          "Codex owns MCP configuration; Codez server overlays cannot be applied",
        );
      return readControlMcp(context);
    }
    case "mcp/projectConfigWrite": {
      const p = input(s.codezMcpProjectConfigWriteParamsSchema, params, method);
      checkWorkspace(p.workspace, context, method);
      return writeProjectMcpConfig(context, p);
    }
    case "provider/updateAccountConfig": {
      const p = input(s.codezProviderUpdateAccountConfigParamsSchema, params, method);
      // 只确认旧 Host 同步信封已收到；0 表示未注册任何 Codez provider，不能覆盖 Codex 凭据。
      return s.codezProviderUpdateAccountConfigResultSchema.parse({
        receivedRevision: p.revision,
        providerCount: 0,
        status: "received",
      });
    }
    case "workspace/updateInteractionPreferences": {
      const p = input(s.codezWorkspaceUpdateInteractionPreferencesParamsSchema, params, method);
      checkWorkspace(p.workspace, context, method);
      if (p.preferences.askUserQuestionAutoResolutionEnabled)
        unsupported(method, "Codex questions require explicit user answers");
      return s.codezWorkspaceUpdateInteractionPreferencesResultSchema.parse({
        workspace: p.workspace,
        askUserQuestionAutoResolutionEnabled: false,
        snoozedInteractionCount: 0,
      });
    }
    case "workspace/updateModelIoPreferences": {
      const p = input(s.codezWorkspaceUpdateModelIoPreferencesParamsSchema, params, method);
      checkWorkspace(p.workspace, context, method);
      if (p.preferences.fullRetentionEnabled)
        unsupported(method, "Codez full model-I/O retention is not implemented for Codex");
      return s.codezWorkspaceUpdateModelIoPreferencesResultSchema.parse({
        workspace: p.workspace,
        fullRetentionEnabled: false,
        updatedSessionCount: 0,
      });
    }
    case "workspace/generateText": {
      const p = input(s.codezWorkspaceGenerateTextParamsSchema, params, method);
      checkWorkspace(p.workspace, context, method);
      // RPC port 无事件订阅，ephemeral thread 又不支持 includeTurns；不能开始一个无法收尾或取消的生成。
      return unsupported(
        method,
        "Restricted ephemeral generation requires turn events and cancellation lifecycle support on the bridge port",
      );
    }
    case "workspace/cancelGenerateText":
      input(s.codezWorkspaceCancelGenerateTextParamsSchema, params, method);
      return unsupported(method, "Auxiliary generation is unavailable; no operation was started");
    default:
      return unsupported(method, "No Codex control-plane mapping");
  }
}
