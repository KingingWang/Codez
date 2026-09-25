import { z } from "zod";

/** Consumed subset of the pinned app-server v2 protocol, validated locally.
 * Reference: app-server-protocol/schema/typescript/v2/{Thread,Turn,ThreadItem}.ts.
 * No build/runtime imports from another checkout. Unknown fields are not authority.
 */
const id = z.string().min(1);
const seconds = z.number().nonnegative().refine(Number.isSafeInteger);
const nullableSeconds = seconds.nullish();
const toolStatus = z.enum(["inProgress", "completed", "failed", "declined"]);
const json = z.json();

export const codexUserInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), text_elements: z.array(json).optional() }),
  // pinned native 图片历史返回 detail:null；optional 仅允许缺席，会错误拒绝整个 userMessage。
  z.object({ type: z.literal("image"), url: z.string(), detail: z.string().nullish() }),
  // turn/start 可先发送尚未转为 data URL 的 localImage，原生 detail 同样可能为 null。
  z.object({ type: z.literal("localImage"), path: z.string(), detail: z.string().nullish() }),
  z.object({ type: z.literal("audio"), url: z.string() }),
  z.object({ type: z.literal("localAudio"), path: z.string() }),
  z.object({ type: z.literal("skill"), name: z.string(), path: z.string() }),
  z.object({ type: z.literal("mention"), name: z.string(), path: z.string() }),
]);
export type CodexUserInput = z.infer<typeof codexUserInputSchema>;

const fileChangeSchema = z.object({
  path: z.string(),
  diff: z.string(),
  kind: z.discriminatedUnion("type", [
    z.object({ type: z.literal("add") }),
    z.object({ type: z.literal("delete") }),
    z.object({ type: z.literal("update"), move_path: z.string().nullable() }),
  ]),
});

const codexKnownItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("userMessage"),
    id,
    clientId: id.nullish(),
    content: z.array(codexUserInputSchema),
  }),
  z.object({
    type: z.literal("agentMessage"),
    id,
    text: z.string(),
    phase: z.enum(["commentary", "final_answer"]).nullish(),
  }),
  z.object({ type: z.literal("plan"), id, text: z.string() }),
  z.object({
    type: z.literal("reasoning"),
    id,
    summary: z.array(z.string()),
    content: z.array(z.string()),
  }),
  z.object({
    type: z.literal("commandExecution"),
    id,
    command: z.string(),
    cwd: z.string(),
    status: toolStatus,
    aggregatedOutput: z.string().nullish(),
    exitCode: z.number().int().nullish(),
    durationMs: z.number().nonnegative().nullish(),
  }),
  z.object({
    type: z.literal("fileChange"),
    id,
    status: toolStatus,
    changes: z.array(fileChangeSchema),
  }),
  z.object({
    type: z.literal("mcpToolCall"),
    id,
    server: id,
    tool: id,
    status: z.enum(["inProgress", "completed", "failed"]),
    arguments: json,
    result: z
      .object({ content: z.array(json), structuredContent: json.nullish(), _meta: json.nullish() })
      .nullish(),
    error: z.object({ message: z.string() }).nullish(),
  }),
]);
export type CodexKnownItem = z.infer<typeof codexKnownItemSchema>;
const knownItemTypes = new Set(
  codexKnownItemSchema.options.map((schema) => schema.shape.type.value),
);
// 已知类型不可走未知兜底，否则损坏的 command/userMessage 会被当成合法历史。
const codexUnknownItemSchema = z
  .object({
    type: z
      .string()
      .min(1)
      .refine((type) => !knownItemTypes.has(type as CodexKnownItem["type"])),
    id,
  })
  .catchall(json);
export const codexThreadItemSchema = z.union([codexKnownItemSchema, codexUnknownItemSchema]);
export type CodexThreadItem = z.infer<typeof codexThreadItemSchema>;
export function isCodexKnownItem(item: CodexThreadItem): item is CodexKnownItem {
  return knownItemTypes.has(item.type as CodexKnownItem["type"]);
}

export const codexTurnSchema = z.object({
  id,
  items: z.array(codexThreadItemSchema),
  itemsView: z.enum(["full", "summary", "notLoaded"]),
  status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
  error: z
    .object({
      message: z.string(),
      additionalDetails: z.string().nullish(),
      codexErrorInfo: json.nullish(),
    })
    .nullish(),
  startedAt: nullableSeconds,
  completedAt: nullableSeconds,
  durationMs: z.number().nonnegative().nullish(),
});
export type CodexTurn = z.infer<typeof codexTurnSchema>;

export const codexThreadStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notLoaded") }),
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("systemError") }),
  z.object({
    type: z.literal("active"),
    activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])),
  }),
]);

export const codexThreadSchema = z.object({
  id,
  preview: z.string(),
  name: z.string().nullish(),
  modelProvider: z.string(),
  model: z.string().nullish(),
  reasoningEffort: z.string().nullish(),
  createdAt: seconds,
  updatedAt: seconds,
  cwd: z.string(),
  forkedFromId: id.nullish(),
  parentThreadId: id.nullish(),
  status: codexThreadStatusSchema,
  turns: z.array(codexTurnSchema),
  // Native token usage is additive telemetry. Unknown or malformed fields must never
  // be coerced to zero during projection.
  tokenUsage: z.unknown().optional(),
});
export type CodexThread = z.infer<typeof codexThreadSchema>;

export const codexQueuedSubmissionSchema = z.object({
  id,
  input: z.array(codexUserInputSchema),
  clientUserMessageId: id,
});
export type CodexQueuedSubmission = z.infer<typeof codexQueuedSubmissionSchema>;
export const codexQueueListSchema = z.object({
  data: z.array(codexQueuedSubmissionSchema),
  nextCursor: z.string().nullable(),
});
export type CodexQueueList = z.infer<typeof codexQueueListSchema>;
