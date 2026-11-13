import type {
  RendererTelemetryEventPayload,
  WebRemoteControlPlatformMethod,
  WebRemoteControlPlatformMethodArgsMap,
  WebRemoteControlPlatformMethodResultMap,
} from "@codez/shared";

export interface WebRemoteControlPlatformProxy {
  reportTelemetryEvent?: (event: RendererTelemetryEventPayload) => void;
  requestPlatformMethod<K extends WebRemoteControlPlatformMethod>(
    method: K,
    args?: WebRemoteControlPlatformMethodArgsMap[K],
  ): Promise<WebRemoteControlPlatformMethodResultMap[K]>;
}
