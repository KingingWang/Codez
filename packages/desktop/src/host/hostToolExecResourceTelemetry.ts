import type { IDisposable } from "@codez/rpc";
import type { ICodezAgentService } from "@codez/services";
import { HostResponseTypes, type ProcessResourceRuntimeSurface } from "@codez/shared";

export function registerHostToolExecResourceTelemetry(options: {
  agentService: Pick<ICodezAgentService, "onDynamicToolExecResource">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
}): IDisposable {
  return options.agentService.onDynamicToolExecResource()((sample) => {
    try {
      options.postMessage({
        type: HostResponseTypes.ToolExecResource,
        runtimeSurface: options.runtimeSurface,
        sample,
      });
    } catch {
      // main 退出或通道关闭只丢当前完成事实，不影响 Bash 生命周期。
    }
  });
}
