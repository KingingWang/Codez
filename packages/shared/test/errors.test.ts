import { describe, expect, it } from "vitest";
import {
  isOpenCodeRuntimeCrashError,
  isCodezFileLockTimeoutError,
  normalizeUnknownError,
  CODEZ_FILE_LOCK_TIMEOUT_ERROR_CODE,
} from "../src/errors.js";

describe("normalizeUnknownError", () => {
  it("extracts code and message from plain json-rpc errors", () => {
    expect(
      normalizeUnknownError({
        code: -32603,
        message: "Internal error: You've hit your limit · resets 9pm (Asia/Shanghai)",
      }),
    ).toEqual({
      code: "-32603",
      message: "Internal error: You've hit your limit · resets 9pm (Asia/Shanghai)",
    });
  });

  it("unwraps nested error envelopes", () => {
    expect(
      normalizeUnknownError({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal error: You've hit your limit · resets 9pm (Asia/Shanghai)",
        },
      }),
    ).toEqual({
      code: "-32603",
      message: "Internal error: You've hit your limit · resets 9pm (Asia/Shanghai)",
    });
  });
});

describe("isOpenCodeRuntimeCrashError", () => {
  it("matches Bun crash signatures", () => {
    expect(isOpenCodeRuntimeCrashError("oh no: Bun has crashed. Segmentation fault")).toBe(true);
    expect(isOpenCodeRuntimeCrashError("[Codez Agent] opencode runtime 崩溃 (code=3221226505)")).toBe(true);
  });

  it("does not match generic connection failures", () => {
    expect(isOpenCodeRuntimeCrashError("Codez Agent connection closed")).toBe(false);
  });
});

describe("isCodezFileLockTimeoutError", () => {
  it("matches direct and RPC-wrapped timeout codes", () => {
    expect(isCodezFileLockTimeoutError({ code: CODEZ_FILE_LOCK_TIMEOUT_ERROR_CODE })).toBe(true);
    expect(
      isCodezFileLockTimeoutError({
        error: { code: CODEZ_FILE_LOCK_TIMEOUT_ERROR_CODE, message: "lock timeout" },
      }),
    ).toBe(true);
  });

  it("does not classify legacy EEXIST as the explicit timeout code", () => {
    expect(isCodezFileLockTimeoutError({ code: "EEXIST" })).toBe(false);
  });
});
