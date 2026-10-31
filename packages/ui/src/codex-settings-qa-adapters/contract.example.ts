import type { CodexSettingsQaRunEvidence } from "./contract.js";

/** 示例结构，不是已执行验证的通过声明。 */
export const qaEvidenceShapeExample = {
  entrypoint: "interaction-e2e.mjs",
  exitCode: 0,
  completedChecks: ["example-only"],
  skippedChecks: [],
} satisfies CodexSettingsQaRunEvidence;
