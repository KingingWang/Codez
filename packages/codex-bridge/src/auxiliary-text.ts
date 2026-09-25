import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  codezWorkspaceGenerateTextParamsSchema,
  codezWorkspaceGenerateTextResultSchema,
  codezWorkspaceCancelGenerateTextParamsSchema,
  codezWorkspaceCancelGenerateTextResultSchema,
  type CodezWorkspaceGenerateTextParams,
} from "@codez/shared";
import type { CodexProcess, CodexNotification } from "./contract.js";

export interface AuxiliaryTextOptions {
  rpc: CodexProcess;
  cwd: string;
}
const DEADLINE_MS = 30_000;
const MAX_TEXT_BYTES = 64 * 1024;
const disabledFeatures = [
  "apps",
  "code_mode",
  "code_mode_only",
  "context_management",
  "current_time_reminder",
  "deferred_executor",
  "enable_fanout",
  "goals",
  "hooks",
  "image_generation",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "request_permissions_tool",
  "shell_snapshot",
  "shell_tool",
  "standalone_web_search",
  "token_budget",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "js_repl",
  "js_repl_tools_only",
  "browser_use",
  "browser_use_full_cdp_access",
  "browser_use_external",
  "computer_use",
  "remote_plugin",
  "artifact",
  "sleep_tool",
];
const object = z.record(z.string(), z.unknown());
const identifier = z.object({ id: z.string().min(1) });
const startSchema = z.object({
  thread: identifier.extend({ ephemeral: z.literal(true) }),
  cwd: z.string(),
  model: z.string(),
  modelProvider: z.string(),
  approvalPolicy: z.literal("never"),
  sandbox: z.object({ type: z.literal("readOnly"), networkAccess: z.literal(false) }),
});
type Operation = {
  id: string;
  threadId?: string;
  turnId?: string;
  admitting: boolean;
  terminal: boolean;
  stopped?: Error;
  text?: string;
  events: CodexNotification[];
  output: ReturnType<typeof Promise.withResolvers<string>>;
  abort: ReturnType<typeof Promise.withResolvers<never>>;
  interrupt?: Promise<void>;
  cleanup?: Promise<void>;
};
function error(code: number, message: string): Error {
  return Object.assign(new Error(message), { code, data: { reason: message } });
}
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw error(-32602, "Invalid auxiliary text parameters");
  return parsed.data;
}
async function boundedCleanup(action: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      action,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
  } catch {
    /* 清理不重试，不能用未知结果重放原始生成或中断命令。 */
  } finally {
    clearTimeout(timer);
  }
}

/** Adapter spec: caller text → one ephemeral thread → one exact turn → final text.
 * Native reference: tui/temporary_structured_request.rs and protocol/v2/thread.rs.
 * Empty environments remove shell/apply_patch registration (core/tools/spec_plan.rs),
 * not merely their prompts. Per-thread config disables extensions, MCP and hooks.
 * No durable config writes, main-thread reuse, automatic retries, or persisted transcript.
 */
export class AuxiliaryText {
  private readonly operations = new Map<string, Operation>();
  private closed = false;
  constructor(private readonly options: AuxiliaryTextOptions) {}

  supports(method: string): boolean {
    return method === "workspace/generateText" || method === "workspace/cancelGenerateText";
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    if (method === "workspace/cancelGenerateText") {
      const p = input(codezWorkspaceCancelGenerateTextParamsSchema, params);
      const op = this.operations.get(p.operationId);
      const cancelled = !!op && !op.terminal && !op.stopped;
      if (cancelled) {
        this.stop(op, error(-32800, "Auxiliary generation cancelled"));
        await this.interrupt(op);
      }
      return codezWorkspaceCancelGenerateTextResultSchema.parse({
        operationId: p.operationId,
        cancelled,
      });
    }
    if (method !== "workspace/generateText")
      throw error(-32601, "Unsupported auxiliary text method");
    const p = input(codezWorkspaceGenerateTextParamsSchema, params);
    if (p.workspace.workspacePath !== this.options.cwd)
      throw error(-32602, "Auxiliary workspace mismatch");
    if (p.tools?.length || p.messages || p.maxOutputTokens !== undefined)
      throw error(
        -32601,
        "Only prompt-only text generation without tools or token-cap overrides is supported",
      );
    if (this.closed) throw error(-32004, "Auxiliary generator is closed");
    const id = p.operationId ?? randomUUID();
    if (this.operations.has(id) || this.operations.size >= 4)
      throw error(-32000, "Auxiliary operation duplicate or capacity limit");
    const op: Operation = {
      id,
      admitting: false,
      terminal: false,
      events: [],
      output: Promise.withResolvers<string>(),
      abort: Promise.withResolvers<never>(),
    };
    this.operations.set(id, op);
    const detach = this.options.rpc.onNotification((event) => this.notification(op, event));
    const detachClose = this.options.rpc.onClose(() =>
      this.stop(op, error(-32000, "Codex process closed during auxiliary generation")),
    );
    const timer = setTimeout(
      () => this.stop(op, error(-32001, "Auxiliary generation timed out")),
      DEADLINE_MS,
    );
    try {
      const text = await Promise.race([this.execute(op, p), op.abort.promise]);
      return codezWorkspaceGenerateTextResultSchema.parse({
        text,
        selection: p.selection,
        finishReason: "stop",
      });
    } finally {
      clearTimeout(timer);
      detach();
      detachClose();
      op.events.length = 0;
      this.operations.delete(id);
      await this.cleanup(op);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const operations = [...this.operations.values()];
    for (const op of operations) this.stop(op, error(-32800, "Auxiliary generator closed"));
    await Promise.all(operations.map((op) => this.cleanup(op)));
  }

  private stop(op: Operation, reason: Error): void {
    if (op.stopped || op.terminal) return;
    op.stopped = reason;
    op.abort.reject(reason);
  }

  private fail(op: Operation, reason: Error): void {
    if (op.terminal) return;
    // malformed completion 可能在 turn/start 回复前到达；必须同时唤醒 execute
    // 和外层 race，否则操作会悬挂到 30 秒 deadline。
    op.terminal = true;
    op.stopped ??= reason;
    op.output.promise.catch(() => {});
    op.abort.promise.catch(() => {});
    op.output.reject(reason);
    op.abort.reject(reason);
  }

  private check(op: Operation): void {
    if (op.stopped) throw op.stopped;
  }

  private async execute(op: Operation, p: CodezWorkspaceGenerateTextParams): Promise<string> {
    try {
      const { config } = z
        .object({ config: z.object({ mcp_servers: z.record(z.string(), object).optional() }) })
        .parse(
          await this.options.rpc.request("config/read", {
            cwd: this.options.cwd,
            includeLayers: false,
          }),
        );
      this.check(op);
      const overrides = {
        ...Object.fromEntries(disabledFeatures.map((feature) => [`features.${feature}`, false])),
        "orchestrator.skills.enabled": false,
        "skills.include_instructions": false,
        "token_budget.use_history_notes_extension": false,
        "tools.experimental_request_user_input.enabled": false,
        "tools.update_plan.enabled": false,
        web_search: "disabled",
        notify: [],
        project_doc_max_bytes: 0,
        mcp_servers: Object.fromEntries(
          Object.keys(config.mcp_servers ?? {}).map((name) => [name, { enabled: false }]),
        ),
      };
      const raw = await this.options.rpc.request("thread/start", {
        cwd: this.options.cwd,
        model: p.selection.modelId,
        modelProvider: p.selection.providerId,
        sandbox: "read-only",
        approvalPolicy: "never",
        ephemeral: true,
        threadSource: "system",
        environments: [],
        runtimeWorkspaceRoots: [],
        dynamicTools: [],
        selectedCapabilityRoots: [],
        config: overrides,
      });
      // 先取线程 id 再校验限制，校验失败也必须卸载已创建的线程。
      op.threadId = z.object({ thread: identifier }).parse(raw).thread.id;
      this.check(op);
      const start = startSchema.parse(raw);
      if (
        start.cwd !== this.options.cwd ||
        start.model !== p.selection.modelId ||
        start.modelProvider !== p.selection.providerId
      )
        throw error(-32000, "Codex substituted auxiliary execution identity");
      op.admitting = true;
      try {
        const turn = z.object({ turn: identifier }).parse(
          await this.options.rpc.request("turn/start", {
            threadId: op.threadId,
            input: [{ type: "text", text: p.prompt!, text_elements: [] }],
            ...(p.selection.options?.reasoningLevel
              ? { effort: p.selection.options.reasoningLevel }
              : {}),
          }),
        );
        op.turnId = turn.turn.id;
      } finally {
        op.admitting = false;
      }
      this.check(op);
      for (const event of op.events.splice(0)) this.notification(op, event);
      this.check(op);
      return await op.output.promise;
    } catch (cause) {
      if (!op.stopped && !op.terminal)
        op.stopped = cause instanceof Error ? cause : error(-32000, "Auxiliary generation failed");
      throw cause;
    } finally {
      await this.cleanup(op);
    }
  }

  private notification(op: Operation, event: CodexNotification): void {
    if (!op.threadId || op.stopped || op.terminal) return;
    const parsed = object.safeParse(event.params);
    if (!parsed.success || parsed.data.threadId !== op.threadId) return;
    if (!["item/completed", "item/started", "turn/completed"].includes(event.method)) return;
    const completedTurn =
      event.method === "turn/completed"
        ? z
            .object({
              turn: identifier.extend({
                status: z.enum(["completed", "failed", "interrupted"]),
              }),
            })
            .safeParse(event.params)
        : undefined;
    // malformed completion 可能在 turn/start 回复前到达；这种事件无法通过等待
    // turn id 变成有效结果，必须立即终止而不是进入重放缓冲。
    if (completedTurn && !completedTurn.success) {
      this.fail(op, error(-32000, "Auxiliary turn completion is malformed"));
      return;
    }
    if (!op.turnId) {
      if (op.events.length >= 64) this.stop(op, error(-32000, "Auxiliary event buffer exceeded"));
      else op.events.push(event);
      return;
    }
    if (completedTurn) {
      const turn = completedTurn.data.turn;
      if (turn.id !== op.turnId) return;
      if (turn.status !== "completed" || op.text === undefined) {
        this.fail(op, error(-32000, `Auxiliary turn ${turn.status} without usable final text`));
        return;
      }
      op.terminal = true;
      op.output.resolve(op.text);
      return;
    }
    try {
      const value = z.object({ turnId: z.string(), item: object }).parse(event.params);
      if (value.turnId !== op.turnId) return;
      if (!["agentMessage", "reasoning", "userMessage"].includes(String(value.item.type)))
        throw error(-32000, "Restricted auxiliary thread attempted a tool operation");
      if (
        event.method === "item/completed" &&
        value.item.type === "agentMessage" &&
        value.item.phase !== "commentary"
      ) {
        const text = z.string().parse(value.item.text);
        if (Buffer.byteLength(text) > MAX_TEXT_BYTES)
          throw error(-32000, "Auxiliary text output exceeds limit");
        op.text = text;
      }
    } catch (cause) {
      this.stop(op, cause instanceof Error ? cause : error(-32000, "Invalid auxiliary event"));
    }
  }

  private interrupt(op: Operation): Promise<void> {
    if (!op.threadId || !op.turnId || op.terminal) return Promise.resolve();
    return (op.interrupt ??= this.options.rpc
      .request("turn/interrupt", { threadId: op.threadId, turnId: op.turnId })
      .then(() => {}));
  }

  private async cleanup(op: Operation): Promise<void> {
    if (!op.threadId || op.admitting) return;
    op.cleanup ??= (async () => {
      if (op.stopped && !op.terminal) await boundedCleanup(this.interrupt(op));
      await boundedCleanup(
        this.options.rpc.request("thread/unsubscribe", { threadId: op.threadId }),
      );
    })();
    await op.cleanup;
  }
}
