import assert from "node:assert/strict";
import test from "node:test";
import { codexAutoReviewApprovalsSupported } from "./useCodexAutoReviewApprovals.js";

function hello(capabilities: unknown): { capabilities?: unknown } {
  return capabilities === undefined ? {} : { capabilities };
}

test("auto review approvals require an explicit supported capability", () => {
  // fail-closed：hello 缺失 capabilities、codex 面缺失、codexUnavailable、
  // 旧 peer 缺省字段、显式 unsupported 都不得放行"帮我审批"档。
  assert.equal(codexAutoReviewApprovalsSupported(hello(undefined)), false);
  assert.equal(codexAutoReviewApprovalsSupported(hello({})), false);
  assert.equal(codexAutoReviewApprovalsSupported(hello({ codexUnavailable: true })), false);
  assert.equal(codexAutoReviewApprovalsSupported(hello({ codex: {} })), false);
  assert.equal(
    codexAutoReviewApprovalsSupported(hello({ codex: { autoReviewApprovals: "unsupported" } })),
    false,
  );
  assert.equal(
    codexAutoReviewApprovalsSupported(hello({ codex: { autoReviewApprovals: "degraded" } })),
    false,
  );
  assert.equal(
    codexAutoReviewApprovalsSupported(hello({ codex: { autoReviewApprovals: "supported" } })),
    true,
  );
});
