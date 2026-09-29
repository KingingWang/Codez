/** Codex is the execution authority; this port never owns a second queue. */
import type { DesktopCodexMcpServer } from "@codez/shared";
import type { OfficialPluginMarketplace } from "./official-plugin-marketplace.js";
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
  /**
   * 开启时给 app-server argv 追加 `-c tools.update_plan.enabled=true`。
   * 工具注册发生在原生配置加载期（server 级覆盖对所有线程生效，包括 resume），
   * 进程启动后不可热切换；开关变更由 Host 负责重启进程。
   */
  updatePlanToolEnabled?: boolean;
  /** 仅桌面 Host 提供的当前 bridge 实例 MCP 配置，不持久化到用户配置。 */
  desktopMcpServers?: DesktopCodexMcpServer[];
  /** Ordinary outbound RPC/write timeout in milliseconds; defaults to 30 seconds. */
  requestTimeoutMs?: number;
  /** Optional positive server-interaction deadline in milliseconds. Omitted means no expiry;
   * human approvals/questions remain pending until reply or connection close, within the cap.
   */
  interactionTimeoutMs?: number;
  /**
   * 超大入站帧被丢弃时的有界回调（同步、禁止抛错）。prefix 仅供离线诊断归属，
   * 消费方只能输出 method/observedBytes 等结构化字段，禁止原文记录。
   */
  onFrameDropped?: (frame: { observedBytes: number; prefix: string }) => void;
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
  officialPlugins?: OfficialPluginMarketplace;
  auxiliary?: { supports(method: string): boolean };
  nativeBrowserCua?: {
    browserAvailable: boolean;
    cuaAvailable: boolean;
  };
}
