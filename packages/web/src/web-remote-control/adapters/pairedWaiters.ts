export class WebRemoteControlPairedWaiters {
  private readonly waiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  wait(isPaired: () => boolean, timeoutMs: number): Promise<void> {
    if (isPaired()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error("Web remote control relay did not recover before timeout."));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  resolveAll(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.waiters.clear();
  }

  rejectAll(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}
