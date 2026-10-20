/** Transport diagnostics deliberately exclude frames, stdin, stderr and environment. */
export class CodexTransportError extends Error {
  constructor(
    readonly code:
      | "STARTUP"
      | "CLOSED"
      | "PROTOCOL"
      | "TIMEOUT"
      | "NOT_READY"
      | "LIMIT"
      | "INVALID",
    message: string,
  ) {
    super(message);
    this.name = "CodexTransportError";
  }
}

export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}
