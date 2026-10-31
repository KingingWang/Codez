import type { ISystemService } from "@codez/services";

export type { ISystemService } from "@codez/services";
export type { SystemInfo } from "@codez/shared";

/** 真实运行时模式由所属 Host info 读取，Root 不保存另一份 provider authority。 */
export type ProviderBootstrapRuntimePort = Pick<ISystemService, "info">;
