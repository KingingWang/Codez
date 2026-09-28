import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";

export const APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL = "settings:app-runtime-preferences";
export const ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV = "CODEZ_E2E_ASK_USER_QUESTION_CLOCK_SCALE";

export const appRuntimePreferencesChangedBroadcastPayloadSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    modelIoFullRetentionEnabled: z.boolean().default(false),
    // 记忆偏好随同一广播跨窗口同步；旧版本窗口发送的 payload 可缺席。
    memoryEnabled: z.boolean().optional(),
    memoryUseEnabled: z.boolean().optional(),
    memoryExtractionEnabled: z.boolean().optional(),
    memoryExtractionModel: modelSelectionSchema.nullish(),
  })
  .strict();

export type AppRuntimePreferencesChangedBroadcastPayload = z.infer<
  typeof appRuntimePreferencesChangedBroadcastPayloadSchema
>;
