import type { resolveCodexBridgeCommand, usesCodexBridgeRuntime } from "../codexBridgeCommand.js";
import type { parseCodexBridgeTitleDiagnostic } from "../codexBridgeTitleDiagnostic.js";
import type { createCodexSessionEventProjection } from "../codexSessionEventProjection.js";

export type { CodexBridgeTitleDiagnostic } from "../codexBridgeTitleDiagnostic.js";
export type { CodexSessionEventProjection } from "../codexSessionEventProjection.js";

export type ResolveCodexBridgeCommand = typeof resolveCodexBridgeCommand;
export type UsesCodexBridgeRuntime = typeof usesCodexBridgeRuntime;
export type ParseCodexBridgeTitleDiagnostic = typeof parseCodexBridgeTitleDiagnostic;
export type CreateCodexSessionEventProjection = typeof createCodexSessionEventProjection;

/** 复用原入口的类型；进程、native thread 和差分投影仍由各自原 owner 持有。 */
export interface CodexNativeSessionAdapterContract {
  readonly resolveCommand: ResolveCodexBridgeCommand;
  readonly usesRuntime: UsesCodexBridgeRuntime;
  readonly parseTitleDiagnostic: ParseCodexBridgeTitleDiagnostic;
  readonly createEventProjection: CreateCodexSessionEventProjection;
}
