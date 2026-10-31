import type { UsesCodexBridgeRuntime } from "./contract.js";

export const desktopRuntimeSelectionExample = {
  desktopDefault: true,
  customCommandResolver: false,
} satisfies Parameters<UsesCodexBridgeRuntime>[0];

/** 显式注入合成环境，不读取或修改示例执行者的进程环境。 */
export function nativeRuntimeSelectionExample(usesRuntime: UsesCodexBridgeRuntime): boolean {
  return usesRuntime(desktopRuntimeSelectionExample, { CODEZ_DESKTOP_RUNTIME: "codex" });
}
