import { z } from "zod";
import type { BridgeControlContext } from "./contract.js";

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
      await context.rpc.request(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) }),
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
    approval_policy: z.unknown().optional(),
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
    await context.rpc.request("config/read", { cwd: context.cwd, includeLayers: false }),
  ).config;
}
