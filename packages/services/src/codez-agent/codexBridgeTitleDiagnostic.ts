/** Bridge stderr is not a trusted log transport; accept only the bounded fields we emit. */
export function parseCodexBridgeTitleDiagnostic(
  line: string,
): { stage: string; code: string } | undefined {
  const match =
    /^Codex desktop bridge warn: automatic title failed; stage=(availability|generation|native-read|native-write); code=(-?\d{1,7}|STARTUP|CLOSED|PROTOCOL|TIMEOUT|NOT_READY|LIMIT|INVALID|unknown)$/.exec(
      line,
    );
  return match ? { stage: match[1]!, code: match[2]! } : undefined;
}
