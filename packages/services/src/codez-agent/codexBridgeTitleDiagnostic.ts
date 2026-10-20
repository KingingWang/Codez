/** Bridge stderr is not a trusted log transport; accept only the bounded fields we emit. */
export type CodexBridgeTitleDiagnostic =
  | { kind: "failed"; stage: string; code: string }
  | { kind: "skipped"; stage: string; reason: string };

// 两份白名单必须与 packages/codex-bridge/src/session-title.ts 的 SkipStage / SkipReason
// 及 generate() 的失败阶段同步；不在闭合词汇内的行按不可信 stderr 丢弃，不进生产日志。
const FAILED =
  /^Codex desktop bridge warn: automatic title failed; stage=(availability|generation|native-read|native-write); code=(-?\d{1,7}|STARTUP|CLOSED|PROTOCOL|TIMEOUT|NOT_READY|LIMIT|INVALID|unknown)$/;
const SKIPPED =
  /^Codex desktop bridge warn: automatic title skipped; stage=(arm|input|availability|generation|native-read); reason=(missing-selection|short-input|unavailable|invalid-title|renamed|first-item-mismatch)$/;

export function parseCodexBridgeTitleDiagnostic(
  line: string,
): CodexBridgeTitleDiagnostic | undefined {
  const failed = FAILED.exec(line);
  if (failed) return { kind: "failed", stage: failed[1]!, code: failed[2]! };
  const skipped = SKIPPED.exec(line);
  if (skipped) return { kind: "skipped", stage: skipped[1]!, reason: skipped[2]! };
  return undefined;
}
