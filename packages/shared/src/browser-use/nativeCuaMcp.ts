import { z } from "zod";

export const NATIVE_BROWSER_CUA_MCP_CUA_METHODS = [
  "list_apps",
  "list_windows",
  "get_app_state",
  "left_click",
  "left_click_drag",
  "scroll",
  "type",
  "set_value",
  "select_text",
  "key",
  "paste",
  "perform_action",
  "request_access",
  "stop_computer_control",
] as const;

export const nativeBrowserCuaMcpCuaMethodSchema = z.enum(NATIVE_BROWSER_CUA_MCP_CUA_METHODS);
export type NativeBrowserCuaMcpCuaMethod = z.infer<typeof nativeBrowserCuaMcpCuaMethodSchema>;

const cuaAppRefSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    bundle_id: z.string().trim().min(1).optional(),
    pid: z.number().int().positive().optional(),
    window_id: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((ref) => ref.name !== undefined || ref.bundle_id !== undefined || ref.pid !== undefined, {
    message: "app_ref must identify an application by name, bundle_id, or pid",
  });

const cuaTargetSchema = z.union([
  z.number().int().nonnegative(),
  z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  z
    .object({
      type: z.literal("element"),
      index: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("coordinate"),
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
      frame_id: z.string().trim().min(1).optional(),
    })
    .strict(),
]);

const cuaStrategySchema = z.enum(["auto", "a11y", "event"]);
const cuaReturnStateSchema = z.enum(["none", "compact", "full"]);

export const nativeBrowserCuaMcpCuaCommandSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("list_apps") }).strict(),
  z
    .object({
      method: z.literal("list_windows"),
      app_ref: cuaAppRefSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("get_app_state"),
      app_ref: cuaAppRefSchema,
      include_screenshot: z.boolean().optional(),
      disable_diffing: z.boolean().optional(),
      tree_shown_to_model: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("left_click"),
      target: cuaTargetSchema,
      mouse_button: z.enum(["left", "right", "middle"]).optional(),
      click_count: z.number().int().positive().optional(),
      modifiers: z.string().optional(),
      strategy: cuaStrategySchema.optional(),
      app_ref: cuaAppRefSchema.optional(),
      return_state: cuaReturnStateSchema.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("left_click_drag"),
      from_target: cuaTargetSchema,
      to: cuaTargetSchema,
      modifiers: z.string().optional(),
      app_ref: cuaAppRefSchema.optional(),
      return_state: cuaReturnStateSchema.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("scroll"),
      target: cuaTargetSchema,
      scroll_direction: z.enum(["up", "down", "left", "right"]),
      scroll_amount: z.number().nonnegative(),
      strategy: cuaStrategySchema.optional(),
      app_ref: cuaAppRefSchema.optional(),
      return_state: cuaReturnStateSchema.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("type"),
      text: z.string(),
      target: cuaTargetSchema.optional(),
      app_ref: cuaAppRefSchema.optional(),
      strategy: cuaStrategySchema.optional(),
      return_state: cuaReturnStateSchema.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("set_value"),
      target: cuaTargetSchema,
      value: z.string(),
      strategy: cuaStrategySchema.optional(),
      app_ref: cuaAppRefSchema.optional(),
      return_state: cuaReturnStateSchema.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("select_text"),
      target: cuaTargetSchema,
      text_range: z
        .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
        .optional(),
      app_ref: cuaAppRefSchema.optional(),
      return_state: cuaReturnStateSchema.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("key"),
      text: z.string().trim().min(1),
      repeat: z.number().int().min(1).max(100).optional(),
      hold_seconds: z.number().min(0).max(60).optional(),
      app_ref: cuaAppRefSchema.optional(),
      strategy: cuaStrategySchema.optional(),
      return_state: cuaReturnStateSchema.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("paste"),
      text: z.string(),
      format: z.enum(["text", "md", "html"]).optional(),
      app_ref: cuaAppRefSchema.optional(),
      return_state: cuaReturnStateSchema.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("perform_action"),
      target: cuaTargetSchema,
      action: z.string().trim().min(1),
      app_ref: cuaAppRefSchema.optional(),
      return_state: cuaReturnStateSchema.optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("request_access"),
      capabilities: z.array(z.string().trim().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("stop_computer_control"),
      reason: z.string().optional(),
    })
    .strict(),
]);
export type NativeBrowserCuaMcpCuaCommand = z.infer<typeof nativeBrowserCuaMcpCuaCommandSchema>;

type CuaCommandJsonVariant = {
  properties: Record<string, Record<string, unknown>> & { method: { const: string } };
};

// 修复依据：手写广告 schema 把 target/from_target/to 声明为 {}，模型无法获得真实
// JSON 类型。字段直接取自运行时同一联合，保留嵌套 anyOf；仅顶层按 method 扁平化，
// 避免再维护一份可能遗漏字段或混入 browser drag/modifiers 类型的声明。
const cuaCommandJsonVariants = z.toJSONSchema(nativeBrowserCuaMcpCuaCommandSchema, {
  io: "input",
  reused: "inline",
}).oneOf as CuaCommandJsonVariant[];

const cuaCommandProperties: Record<string, Record<string, unknown>> = {
  method: { type: "string", enum: [...NATIVE_BROWSER_CUA_MCP_CUA_METHODS] },
};
const cuaFieldVariants = new Map<string, Map<string, Record<string, unknown>>>();
const generatedCuaMethods = new Set<string>();
for (const variant of cuaCommandJsonVariants) {
  generatedCuaMethods.add(variant.properties.method.const);
  for (const [field, schema] of Object.entries(variant.properties)) {
    if (field === "method") continue;
    const alternatives = cuaFieldVariants.get(field) ?? new Map();
    alternatives.set(JSON.stringify(schema), schema);
    cuaFieldVariants.set(field, alternatives);
  }
}
for (const [field, alternatives] of cuaFieldVariants) {
  const schemas = [...alternatives.values()] as [
    Record<string, unknown>,
    ...Record<string, unknown>[],
  ];
  // text 在 key 中非空，在 type/paste 中允许空串；字段声明取各方法合法形状的并集，
  // 逐方法约束仍交给运行时校验，不因扁平化丢失嵌套 target 联合。
  cuaCommandProperties[field] = schemas.length === 1 ? schemas[0] : { anyOf: schemas };
}
if (
  generatedCuaMethods.size !== NATIVE_BROWSER_CUA_MCP_CUA_METHODS.length ||
  NATIVE_BROWSER_CUA_MCP_CUA_METHODS.some((method) => !generatedCuaMethods.has(method))
) {
  throw new Error("Native CUA MCP methods drifted from the runtime command schema");
}

export const nativeBrowserCuaMcpCuaCommandJsonSchema: {
  type: "object";
  [key: string]: unknown;
} = {
  type: "object",
  properties: cuaCommandProperties,
  required: ["method"],
  additionalProperties: false,
};
