import assert from "node:assert/strict";
import test from "node:test";
import type { GitBranchDeletePreview } from "@codez/shared";
import {
  canConfirmBranchDeletion,
  createInitialBranchDeletionState,
  extractBranchDeletionIssue,
  resolveBranchDeletionBlock,
} from "./branchDeletionModel.js";

function preview(overrides: Partial<GitBranchDeletePreview> = {}): GitBranchDeletePreview {
  return {
    branchName: "feature/old",
    isCurrent: false,
    checkedOutPath: null,
    isMerged: true,
    commitHash: "abc1234",
    commitSubject: "subject",
    upstreamName: null,
    ...overrides,
  };
}

function confirmState(p: GitBranchDeletePreview) {
  return { ...createInitialBranchDeletionState(), phase: "confirm" as const, preview: p };
}

test("已合并空闲分支直接可删；未合并/未知必须勾选强删确认（B3）", () => {
  assert.equal(canConfirmBranchDeletion(confirmState(preview())), true);
  for (const isMerged of [false, null] as const) {
    const state = confirmState(preview({ isMerged }));
    assert.equal(canConfirmBranchDeletion(state), false);
    assert.equal(canConfirmBranchDeletion({ ...state, forceConfirmed: true }), true);
  }
});

test("当前分支与被占用分支阻塞", () => {
  assert.equal(resolveBranchDeletionBlock(preview({ isCurrent: true })), "current");
  assert.equal(
    resolveBranchDeletionBlock(preview({ checkedOutPath: "/repo-worktrees/a" })),
    "occupied",
  );
  assert.equal(resolveBranchDeletionBlock(preview()), null);
  assert.equal(canConfirmBranchDeletion(confirmState(preview({ checkedOutPath: "/x" }))), false);
});

test("extractBranchDeletionIssue 携带最新预览", () => {
  const latest = preview({ commitHash: "def5678" });
  const error = Object.assign(new Error("moved"), {
    code: "branch-moved",
    data: { code: "branch-moved", message: "moved", latestPreview: latest },
  });
  assert.deepEqual(extractBranchDeletionIssue(error), {
    code: "branch-moved",
    message: "moved",
    latestPreview: latest,
  });
  assert.equal(extractBranchDeletionIssue(new Error("plain")), null);
});
