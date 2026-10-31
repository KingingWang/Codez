import type { CodexSettingsQaServices } from "./contract.js";

/** 只读合成 info；fixture 自己注入，不能读取用户目录。 */
export function qaServiceSliceExample(
  systemService: NonNullable<CodexSettingsQaServices["systemService"]>,
) {
  return { systemService } satisfies CodexSettingsQaServices;
}
