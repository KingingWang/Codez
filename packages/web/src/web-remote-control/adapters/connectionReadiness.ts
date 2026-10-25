import type {
  WebRemoteControlConnectionEnsureOptions,
  WebRemoteControlTerminalTransportState,
} from "#src/web-remote-control/contracts/transport.js";

interface WebRemoteControlConnectionReadinessCallbacks {
  getState(): WebRemoteControlTerminalTransportState;
  isReady(): boolean;
  assertCanRecover(): void;
  recoverConnection(timeoutMs: number): Promise<void>;
}

interface ConnectionReadyFlight {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  forcedRecovery?: boolean;
  failureReason?: WebRemoteControlConnectionEnsureOptions["failureReason"];
}

/**
 * Transport readiness is shared by bridge, bootstrap and platform requests.
 * It owns only connection admission/waiting, not socket or application state.
 */
export class WebRemoteControlConnectionReadiness {
  private e2eeGeneration = 0;
  private flight?: ConnectionReadyFlight;

  constructor(private readonly callbacks: WebRemoteControlConnectionReadinessCallbacks) {}

  markE2eeReset(): void {
    this.e2eeGeneration += 1;
  }

  async ensure(options: WebRemoteControlConnectionEnsureOptions = {}): Promise<void> {
    this.callbacks.assertCanRecover();
    if (this.callbacks.isReady()) return;

    if (this.callbacks.getState() === "suspended") {
      try {
        await this.ensureSuspended(options);
        return;
      } catch (error) {
        if (
          !options.failureReason ||
          !this.callbacks.isReady() ||
          (error instanceof Error && error.name === "AbortError")
        )
          throw error;
        return;
      }
    }

    if (this.flight) {
      const flight = this.flight;
      if (options.failureReason && !flight.failureReason) {
        flight.failureReason = options.failureReason;
      }
      const generation = this.e2eeGeneration;
      try {
        await flight.promise;
        if (generation !== this.e2eeGeneration) {
          throw new Error("Web remote control connection generation changed while waiting.");
        }
        this.callbacks.assertCanRecover();
        if (this.callbacks.isReady()) return;
      } catch (error) {
        if (
          !options.failureReason ||
          generation !== this.e2eeGeneration ||
          !this.callbacks.isReady()
        )
          throw error;
        return;
      }
    }

    const generation = this.e2eeGeneration;
    const flight = this.createFlight(options.timeoutMs ?? 15_000, options);
    try {
      await flight.promise;
      if (generation !== this.e2eeGeneration) {
        throw new Error("Web remote control connection generation changed while waiting.");
      }
      this.callbacks.assertCanRecover();
      if (!this.callbacks.isReady()) {
        throw new Error("Web remote control transport did not become ready.");
      }
    } catch (error) {
      if (!options.failureReason || generation !== this.e2eeGeneration || !this.callbacks.isReady())
        throw error;
    } finally {
      if (this.flight === flight) {
        clearTimeout(flight.timeoutTimer);
        this.flight = undefined;
      }
    }
  }

  onStateChange(state: WebRemoteControlTerminalTransportState): void {
    if (state === "paired" && this.flight && this.callbacks.isReady()) {
      this.flight.resolve();
    }
    if ((state === "error" || state === "kicked") && this.flight) {
      this.flight.reject(new Error(`Web remote control transport entered ${state}.`));
    }
  }

  dispose(error = new Error("Web remote control transport disposed.")): void {
    this.flight?.reject(error);
  }

  private createFlight(timeoutMs: number, options: WebRemoteControlConnectionEnsureOptions) {
    const flight = {} as ConnectionReadyFlight;
    flight.failureReason = options.failureReason;
    flight.promise = new Promise<void>((resolve, reject) => {
      flight.resolve = () => {
        clearTimeout(flight.timeoutTimer);
        if (this.flight === flight) this.flight = undefined;
        resolve();
      };
      flight.reject = (error) => {
        clearTimeout(flight.timeoutTimer);
        if (this.flight === flight) this.flight = undefined;
        reject(error);
      };
      flight.timeoutTimer = setTimeout(() => {
        this.upgradeAfterTimeout(flight);
        if (!flight.forcedRecovery) {
          flight.reject(new Error("Web remote control connection readiness timed out."));
        }
      }, timeoutMs);
    });
    this.flight = flight;
    return flight;
  }

  private upgradeAfterTimeout(flight: ConnectionReadyFlight): void {
    if (!flight.failureReason || flight.forcedRecovery) return;
    flight.forcedRecovery = true;
    flight.timeoutTimer = undefined;
    const generation = this.e2eeGeneration;
    void this.callbacks.recoverConnection(15_000).then(
      () => {
        if (generation === this.e2eeGeneration && this.callbacks.isReady()) {
          flight.resolve();
        } else if (this.flight === flight) {
          flight.reject(
            new Error("Web remote control connection generation changed while recovering."),
          );
        }
      },
      (error: unknown) => {
        if (this.flight === flight) {
          flight.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  }

  private async ensureSuspended(options: WebRemoteControlConnectionEnsureOptions): Promise<void> {
    let flight = this.flight;
    if (!flight) {
      flight = this.createFlight(options.timeoutMs ?? 15_000, options);
      void this.callbacks.recoverConnection(options.timeoutMs ?? 15_000).catch(() => undefined);
    }
    const generation = this.e2eeGeneration;
    await flight.promise;
    if (generation !== this.e2eeGeneration) {
      throw new Error("Web remote control connection generation changed while waiting.");
    }
    this.callbacks.assertCanRecover();
    if (!this.callbacks.isReady()) {
      throw new Error("Web remote control transport did not become ready.");
    }
  }
}
