import {
  ChannelClient,
  MessagePortProtocol,
  ProxyChannel,
  type MessagePortLike,
  type MessagePortPayload,
} from "@codez/rpc";
import {
  ICodezTaskService,
  type ICodezTaskService as ICodezTaskServiceShape,
} from "#src/session/codezTaskService.js";
import {
  ICodezAgentService,
  type ICodezAgentService as ICodezAgentServiceShape,
} from "#src/codez-agent/codezAgent.js";
import {
  ICodezSessionService,
  type ICodezSessionService as ICodezSessionServiceShape,
} from "#src/codez-session/codezSession.js";
import {
  IModelSelectionService,
  type IModelSelectionService as IModelSelectionServiceShape,
} from "#src/model-provider/providerFacadeServices.js";

interface PortLike {
  on?(event: "message", listener: (event: { data: MessagePortPayload }) => void): void;
  off?(event: "message", listener: (event: { data: MessagePortPayload }) => void): void;
  addEventListener?(
    event: "message",
    listener: (event: { data: MessagePortPayload }) => void,
  ): void;
  removeEventListener?(
    event: "message",
    listener: (event: { data: MessagePortPayload }) => void,
  ): void;
  postMessage(message: MessagePortPayload): void;
  start?(): void;
  close?(): void;
}

function toMessagePortLike(port: PortLike): MessagePortLike {
  return {
    addEventListener(type, listener) {
      if (port.addEventListener) {
        port.addEventListener(type, listener);
        return;
      }
      port.on?.(type, listener);
    },
    removeEventListener(type, listener) {
      if (port.removeEventListener) {
        port.removeEventListener(type, listener);
        return;
      }
      port.off?.(type, listener);
    },
    postMessage(data) {
      port.postMessage(data);
    },
    start() {
      port.start?.();
    },
    close() {
      port.close?.();
    },
  };
}

export interface RemoteBotWorkspaceRuntimeServices {
  codezAgentService: ICodezAgentServiceShape;
  codezTaskService: ICodezTaskServiceShape;
  codezSessionService: ICodezSessionServiceShape;
  modelSelectionService: IModelSelectionServiceShape;
}

export function createRemoteRuntimeServicesFromPort(
  port: unknown,
): RemoteBotWorkspaceRuntimeServices {
  const protocol = new MessagePortProtocol(toMessagePortLike(port as PortLike));
  const client = new ChannelClient(protocol);
  return {
    codezAgentService: ProxyChannel.toService<ICodezAgentServiceShape>(
      client.getChannel(ICodezAgentService.channelName),
    ),
    codezTaskService: ProxyChannel.toService<ICodezTaskServiceShape>(
      client.getChannel(ICodezTaskService.channelName),
    ),
    codezSessionService: ProxyChannel.toService<ICodezSessionServiceShape>(
      client.getChannel(ICodezSessionService.channelName),
    ),
    modelSelectionService: ProxyChannel.toService<IModelSelectionServiceShape>(
      client.getChannel(IModelSelectionService.channelName),
    ),
  };
}
