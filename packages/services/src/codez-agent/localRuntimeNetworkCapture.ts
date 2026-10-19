import {
  networkCaptureBatchSchema,
  codezProtocolMethods,
  codezProtocolNotifications,
  type NetworkCaptureBatch,
} from "@codez/shared";
import type { IDisposable } from "@codez/rpc";
import type { CodezProtocolClient } from "#src/codez-agent/codezProtocolClient.js";

/** 仅由本机子进程 spawn 点登记；remote RPC/手机 attachment 不登记也不透传启停。 */
export class LocalRuntimeNetworkCapture {
  private readonly clients = new Map<
    CodezProtocolClient,
    { pid: number; subscription?: IDisposable }
  >();
  private captureId: string | null = null;
  private sink?: (batch: NetworkCaptureBatch) => void;

  register(client: CodezProtocolClient, pid: number): () => void {
    this.clients.set(client, { pid });
    if (this.captureId) this.configure(client);
    return () => {
      this.clients.get(client)?.subscription?.dispose();
      this.clients.delete(client);
    };
  }

  setCaptureId(captureId: string | null, sink?: (batch: NetworkCaptureBatch) => void): void {
    this.captureId = captureId;
    this.sink = sink;
    for (const client of this.clients.keys()) this.configure(client);
  }

  private configure(client: CodezProtocolClient): void {
    const entry = this.clients.get(client)!;
    entry.subscription?.dispose();
    entry.subscription = undefined;
    if (client.isDisposed) {
      this.clients.delete(client);
      return;
    }
    if (this.captureId) {
      entry.subscription = client.onNotification((message) => {
        if (message.method !== codezProtocolNotifications.processNetworkRequests) return;
        const result = networkCaptureBatchSchema.safeParse(message.params);
        if (!result.success || result.data.captureId !== this.captureId) return;
        // PID/角色来自本机 spawn 登记，不能采用对端自报身份。
        this.sink?.({
          ...result.data,
          records: result.data.records.map((record) => ({
            ...record,
            pid: entry.pid,
            processType: "cli",
          })),
        });
      });
    }
    void client
      .notify(codezProtocolMethods.processNetworkCapture, { captureId: this.captureId })
      .catch(() => {
        /* 已退出进程无需重试或重启 */
      });
  }
}

export const localRuntimeNetworkCapture = new LocalRuntimeNetworkCapture();
