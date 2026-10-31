import { createRendererCrashRecovery } from "../rendererCrashRecovery.js";
import type { RendererCrashRecoveryFactory } from "./contract.js";

/** 注入 scheduler/reload ports 的既有实现；此示例不执行 timer 或原生 reload。 */
export const rendererCrashRecoveryExample: RendererCrashRecoveryFactory =
  createRendererCrashRecovery;
