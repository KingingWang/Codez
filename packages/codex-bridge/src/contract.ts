/** Codex is the execution authority; this port never owns a second queue. */
export interface CodexRpcPort {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  respond(id: string | number, result: unknown): Promise<void>;
  respondError(id: string | number, error: { code: number; message: string }): Promise<void>;
}

export interface CodexNotification {
  method: string;
  params?: unknown;
}

export interface CodexServerRequest extends CodexNotification {
  id: string | number;
}

export interface CodexProcessOptions {
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Ordinary outbound RPC/write timeout in milliseconds; defaults to 30 seconds. */
  requestTimeoutMs?: number;
  /** Optional positive server-interaction deadline in milliseconds. Omitted means no expiry;
   * human approvals/questions remain pending until reply or connection close, within the cap.
   */
  interactionTimeoutMs?: number;
}

export interface CodexProcess extends CodexRpcPort {
  initialize(): Promise<void>;
  onNotification(listener: (event: CodexNotification) => void): () => void;
  onRequest(listener: (event: CodexServerRequest) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export interface BridgeControlContext {
  rpc: CodexRpcPort;
  cwd: string;
  auxiliary?: { supports(method: string): boolean };
  nativeBrowserCua?: {
    browserAvailable: boolean;
    cuaAvailable: boolean;
  };
}
