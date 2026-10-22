import { z } from "zod";
import type { BridgeControlContext, CodexRpcPort } from "./contract.js";
import {
  isRelaxedThread,
  projectThreadMode,
  type NativePermissionDefaults,
  type TurnPermissionIntent,
} from "./command-input.js";
import type { JsonObject } from "./json.js";

export class ControlError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: { method: string; reason: string },
  ) {
    super(message);
    this.name = "ControlError";
  }
}

export function unsupported(method: string, reason: string): never {
  throw new ControlError(-32601, `${method}: ${reason}`, { method, reason });
}

export function input<T>(schema: z.ZodType<T>, value: unknown, method: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ControlError(-32602, `Invalid parameters for ${method}`, {
      method,
      reason: result.error.message,
    });
  }
  return result.data;
}

export function checkWorkspace(
  workspace: { workspacePath: string },
  context: BridgeControlContext,
  method: string,
): void {
  if (workspace.workspacePath !== context.cwd) {
    throw new ControlError(-32602, "Workspace does not match this bridge attachment", {
      method,
      reason: "workspace_mismatch",
    });
  }
}

/**
 * 合并同一 CodexRpcPort 上完全相同参数的在途只读请求（specs/codex-desktop-adapter.md）。
 * 修复原因：打开/切换远程工作区时，useCodexModelCatalog（config/read + model/list + catalog/read）、
 * workspace/readPresentation 与 workspace-config 订阅快照会并发向同一 codex-bridge 发起多组
 * config/read 与 model/list，在远端原生 app-server 忙于历史扫描时造成只读控制面风暴并触发 30s
 * RPC 超时进而回收进程（stdout_closed）。仅合并在途 Promise，settled 后立即清除，不保留过期缓存。
 */
const inFlightReadsByRpc = new WeakMap<CodexRpcPort, Map<string, Promise<unknown>>>();

function canonicalizeReadKeyValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries.map(([key, entry]) => [key, canonicalizeReadKeyValue(entry)]));
}

export function requestCoalescedRead<T = unknown>(
  rpc: CodexRpcPort,
  method: string,
  params?: unknown,
): Promise<T> {
  let inFlight = inFlightReadsByRpc.get(rpc);
  if (!inFlight) {
    inFlight = new Map();
    inFlightReadsByRpc.set(rpc, inFlight);
  }
  const key = `${method}:${JSON.stringify(canonicalizeReadKeyValue(params ?? null))}`;
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const pending = rpc.request<T>(method, params).finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

export async function readPages<T>(
  context: BridgeControlContext,
  method: string,
  schema: z.ZodType<T>,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const pageSchema = z.object({ data: z.array(schema), nextCursor: z.string().nullable() });
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = pageSchema.parse(
      await requestCoalescedRead(context.rpc, method, {
        ...params,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }),
    );
    rows.push(...result.data);
    if (!result.nextCursor) return rows;
    if (seen.has(result.nextCursor)) break;
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new ControlError(-32000, "Codex pagination did not terminate", {
    method,
    reason: "invalid_pagination",
  });
}

export const configResponseSchema = z.object({
  config: z.object({
    model: z.string().nullable().optional(),
    model_provider: z.string().nullable().optional(),
    model_reasoning_effort: z.string().nullable().optional(),
    sandbox_mode: z
      .enum(["read-only", "workspace-write", "danger-full-access"])
      .nullable()
      .optional(),
    // workspace-write 的生效细节（可写根/网络等）；custom 恢复时保真透传。
    sandbox_workspace_write: z
      .object({
        writable_roots: z.array(z.string()).optional(),
        network_access: z.boolean().optional(),
        exclude_tmpdir_env_var: z.boolean().optional(),
        exclude_slash_tmp: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    approval_policy: z.unknown().optional(),
    approvals_reviewer: z.enum(["user", "auto_review", "guardian_subagent"]).nullable().optional(),
    mcp_servers: z
      .record(
        z.string(),
        z.object({
          command: z.string().optional(),
          url: z.string().optional(),
          enabled: z.boolean().optional(),
        }),
      )
      .optional(),
  }),
});

export async function readConfig(context: BridgeControlContext) {
  return configResponseSchema.parse(
    await requestCoalescedRead(context.rpc, "config/read", {
      cwd: context.cwd,
      includeLayers: false,
    }),
  ).config;
}

/**
 * 读取 config.toml 生效权限值（specs/codex-permission-modes.md）。
 * custom 档从放宽态切回时用它显式恢复原生默认；读取失败或值不可映射时返回
 * undefined，由调用方回退 workspaceWrite + on-request + user 基线。
 */
export async function readNativePermissionDefaults(
  context: BridgeControlContext,
): Promise<NativePermissionDefaults | undefined> {
  let config: z.infer<typeof configResponseSchema>["config"];
  try {
    config = await readConfig(context);
  } catch {
    // 固定文案，不携带路径/配置内容；不阻断提交（spec 失败语义）。
    process.stderr.write(
      "Codex desktop bridge warn: config/read failed while restoring custom permission mode; falling back to the workspace-write baseline.\n",
    );
    return undefined;
  }
  // sandbox_mode → 原生 v2 SandboxPolicy（camelCase 线格式）；
  // granular permission profile 等未知形态不可映射，交由调用方基线兜底。
  const workspaceWrite = config.sandbox_workspace_write;
  const sandboxPolicy =
    config.sandbox_mode === "read-only"
      ? { type: "readOnly", networkAccess: false }
      : config.sandbox_mode === "workspace-write"
        ? {
            type: "workspaceWrite",
            writableRoots: workspaceWrite?.writable_roots ?? [],
            networkAccess: workspaceWrite?.network_access ?? false,
            excludeTmpdirEnvVar: workspaceWrite?.exclude_tmpdir_env_var ?? false,
            excludeSlashTmp: workspaceWrite?.exclude_slash_tmp ?? false,
          }
        : config.sandbox_mode === "danger-full-access"
          ? { type: "dangerFullAccess" }
          : undefined;
  // approval_policy 只透传 bridge 档位使用的两种；untrusted/on-failure 等交由基线兜底。
  const approvalPolicy =
    config.approval_policy === "on-request" || config.approval_policy === "never"
      ? config.approval_policy
      : undefined;
  // guardian_subagent 是 auto_review 的旧别名（serde alias），统一投影为 auto_review。
  const approvalsReviewer =
    config.approvals_reviewer === "auto_review" || config.approvals_reviewer === "guardian_subagent"
      ? "auto_review"
      : config.approvals_reviewer === "user"
        ? "user"
        : undefined;
  if (!sandboxPolicy && !approvalPolicy && !approvalsReviewer) return {};
  return {
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(approvalsReviewer ? { approvalsReviewer } : {}),
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
  };
}

/**
 * 计算本次请求的权限意图（specs/codex-permission-modes.md）：
 * 仅档位相对线程投影发生迁移时下发覆盖，避免每次提交重置原生会话内已授权；
 * custom 从放宽态（完全访问沙箱 / AI 代批）切回时读取 config.toml 生效值恢复，
 * 读取失败回退空 defaults（= workspaceWrite + on-request + user 基线）。
 */
export async function turnPermissionIntent(
  context: BridgeControlContext,
  thread: JsonObject,
  mode: string | undefined,
): Promise<TurnPermissionIntent> {
  const apply = mode !== undefined && mode !== projectThreadMode(thread);
  if (!apply || mode !== "custom" || !isRelaxedThread(thread)) return { apply };
  return { apply, configDefaults: (await readNativePermissionDefaults(context)) ?? {} };
}

/**
 * 抢占共用的中断步骤（specs/codex-desktop-adapter.md）：interrupt 响应以 TurnAborted 为界，返回时线程已空闲。
 * 失败静默——turn 可能恰好已自然完成；紧随的 start 请求以原生线程状态做最终裁决，
 * 线程仍忙时由它原样报错，不能在这里用兜底分支掩盖。
 */
export async function preemptByInterrupt(
  rpc: CodexRpcPort,
  native: { threadId: string },
  turnId: string,
): Promise<void> {
  try {
    await rpc.request("turn/interrupt", { ...native, turnId });
  } catch {
    // 抢占尝试不以前置中断成败为门禁；最终一致性由紧随的 start 请求裁决。
  }
}
/** writer-conflict 只读会话上的既有会话命令拒绝；admit 映射为 guard.codex.writerConflict。 */
export class WriterConflictError extends Error {
  constructor() {
    super("Thread is read-only: another writer holds the session lock");
  }
}

/** 子代理会话只读拒绝；reasonCode 与原生 flavor 同词（guard.subagentReadOnly）。
 * 依据：原生 V2 子线程由父 driver 拥有，客户端 resume 只能成为订阅者，不接受直接输入。 */
export class SubagentReadOnlyError extends Error {
  constructor() {
    super("Subagent sessions are read-only");
  }
}

/** fork 类逃生通道：读源 rollout、不取源写锁（spec: codex-selection-side-chat）。 */
const FORK_ESCAPE_COMMANDS = new Set(["forkAssistant", "createSelectionSideSession"]);

/** 只读线程 deny-by-default：除逃生通道外，既有会话命令一律拒绝。 */
export function assertWritableThreadState(
  state: { readOnly?: string | null },
  commandType: string,
): void {
  if (!state.readOnly || FORK_ESCAPE_COMMANDS.has(commandType)) return;
  if (state.readOnly === "subagent-child") throw new SubagentReadOnlyError();
  // 未知只读原因同样 fail-closed：宁可拒绝写，也不能让只读线程被误判成可写。
  throw new WriterConflictError();
}
