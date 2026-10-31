import type {
  ComputerUseRuntime,
  ComputerUseRuntimeContext,
  CuaHelperBackendContract,
} from "./contract.js";

/** 会话关闭不销毁全局 Helper；关闭进程时才释放 backend。 */
export async function closeHelperSessionExample(
  runtime: ComputerUseRuntime,
  context: ComputerUseRuntimeContext,
): Promise<void> {
  await runtime.closeSession(context);
}

export async function disposeHelperBackendExample(
  backend: CuaHelperBackendContract,
): Promise<void> {
  await backend.dispose();
}
