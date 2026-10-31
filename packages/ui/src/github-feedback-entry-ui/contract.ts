import type { IServiceAccessor } from "@codez/services";
import type { IPlatformService } from "@codez/shared";

export type { IServiceAccessor } from "@codez/services";
export type { FeedbackDeviceInfo, IPlatformService } from "@codez/shared";

/** 只读现场诊断与原平台外部打开能力，不恢复旧 ticket mutation。 */
export type FeedbackEntryDiagnosticsPort = Pick<
  IServiceAccessor["feedbackService"],
  "getDeviceSnapshot"
>;
export type FeedbackEntryPlatformPort = Pick<IPlatformService, "openExternal">;
