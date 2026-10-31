import type { IServiceAccessor } from "@codez/services";
import type { IPlatformService } from "@codez/shared";

export type { ICodezAgentService, IServiceAccessor } from "@codez/services";
export type { IPlatformService } from "@codez/shared";

/** 原 fixtures 组装的 mock ports；不产生真实 Host 或连接。 */
export type CodexSettingsQaServices = Partial<IServiceAccessor>;
export type CodexSettingsQaPlatform = Pick<
  IPlatformService,
  "openExternal" | "showTaskNotification" | "executeDesktopCommand"
>;
