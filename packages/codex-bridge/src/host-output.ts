import { encodeFrame, type RpcEnvelope } from "./rpc-framing.js";

/** Bounded physical output: queued promises retain bytes even before stdout.write. */
export class HostOutput {
  private tail: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  constructor(
    private readonly send: (chunk: string, done: (error?: Error | null) => void) => void,
    private readonly maxBytes = 8 * 1024 * 1024,
    private readonly timeoutMs = 30_000,
  ) {}
  write(frame: RpcEnvelope): Promise<void> {
    const encoded = encodeFrame(frame);
    const bytes = Buffer.byteLength(encoded);
    // 只检查 writableLength 看不到尚未入 stdout 的 Promise 链，慢 Host 会无限堆积。
    if (this.pendingBytes + bytes > this.maxBytes)
      return Promise.reject(new Error("Host output stalled"));
    this.pendingBytes += bytes;
    const next = this.tail
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Host output timed out")),
              this.timeoutMs,
            );
            try {
              this.send(encoded, (error) => {
                clearTimeout(timer);
                if (error) reject(error);
                else resolve();
              });
            } catch (error) {
              clearTimeout(timer);
              reject(error);
            }
          }),
      )
      .finally(() => {
        this.pendingBytes -= bytes;
      });
    this.tail = next;
    return next;
  }
}
