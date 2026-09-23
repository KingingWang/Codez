import type { Event, IDisposable } from "@codez/rpc";
import type { CodezProtocolMessage } from "@codez/shared";

export type CodezProtocolTransportKind = "stdio" | "websocket" | "memory";

export interface CodezProtocolTransportClosedEvent {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
}

export interface CodezProtocolTransport extends IDisposable {
  readonly kind: CodezProtocolTransportKind;
  readonly onMessage: Event<CodezProtocolMessage>;
  readonly onClose: Event<CodezProtocolTransportClosedEvent>;
  send(message: CodezProtocolMessage): Promise<void>;
  disposeAndWait?(): Promise<void>;
}
