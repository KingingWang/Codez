import type { NativeAutomationBackend } from "../broker.js";

export type {
  ComputerUseRuntime,
  ComputerUseRuntimeContext,
  ComputerUseRuntimeOptions,
} from "../index.js";
export type { BrokerComputerUseRuntimeOptions, CuaPermissionGate } from "../runtime.js";
export type { HelperBootstrapCredentials, HelperHealth } from "../broker.js";

/** backend 自有串行化与销毁；broker 仅通过现有控制方法调用。 */
export type CuaHelperBackendContract = NativeAutomationBackend & {
  dispose(): Promise<void>;
};
