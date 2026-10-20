import assert from "node:assert/strict";
import test from "node:test";
import type { GitWorktreeRemovalPreview } from "@codez/shared";
import {
  canConfirmWorktreeRemoval,
  createInitialWorktreeRemovalState,
  extractWorktreeRemovalIssue,
  resolveWorktreeRemovalBlock,
  resolveWorktreeRemovalRisk,
  type WorktreeRemovalUiFacts,
} from "./worktreeRemovalModel.js";

function preview(overrides: Partial<GitWorktreeRemovalPreview> = {}): GitWorktreeRemovalPreview {
  return {
    targetPath: "/repo-worktrees/feature",
    branchName: "feature",
    isDetached: false,
    headCommitHash: "abc1234",
    headReachableFromRef: true,
    isMain: false,
    isLocked: false,
    lockReason: null,
    isReachable: true,
    changes: [],
    totalChangeCount: 0,
    attentionPaths: [],
    attentionTotalCount: 0,
    scanComplete: true,
    statusFingerprint: "fp",
    ...overrides,
  };
}

function facts(overrides: Partial<WorktreeRemovalUiFacts> = {}): WorktreeRemovalUiFacts {
  return { isCurrent: false, openTabs: [], hasRunning: false, ...overrides };
}

function confirmState(p: GitWorktreeRemovalPreview, f: WorktreeRemovalUiFacts = facts()) {
  return {
    ...createInitialWorktreeRemovalState(),
    phase: "confirm" as const,
    preview: p,
    uiFacts: f,
  };
}

test("干净树直接可确认；脏树/敏感配置必须勾选", () => {
  assert.equal(canConfirmWorktreeRemoval(confirmState(preview())), true);
  // 仅 ignored 敏感配置也算脏（审查①）：不允许归入 ready-clean
  const attentionOnly = preview({ attentionPaths: [".env"], attentionTotalCount: 1 });
  assert.equal(resolveWorktreeRemovalRisk(attentionOnly), "dirty");
  assert.equal(canConfirmWorktreeRemoval(confirmState(attentionOnly)), false);
  const confirmed = { ...confirmState(attentionOnly), confirmDiscardChanges: true };
  assert.equal(canConfirmWorktreeRemoval(confirmed), true);
});

test("detached 且提交不可达：独立于脏勾选的二次确认（审查⑤）", () => {
  const detached = preview({
    branchName: null,
    isDetached: true,
    headReachableFromRef: false,
  });
  assert.equal(resolveWorktreeRemovalRisk(detached), "detached");
  assert.equal(canConfirmWorktreeRemoval(confirmState(detached)), false);
  const confirmed = { ...confirmState(detached), confirmDiscardDetachedHead: true };
  assert.equal(canConfirmWorktreeRemoval(confirmed), true);
  // 可达的 detached 不构成风险
  assert.equal(
    resolveWorktreeRemovalRisk(
      preview({ branchName: null, isDetached: true, headReachableFromRef: true }),
    ),
    "clean",
  );
  // 脏 + detached 需要两个勾选
  const both = preview({
    branchName: null,
    isDetached: true,
    headReachableFromRef: false,
    totalChangeCount: 1,
  });
  assert.equal(resolveWorktreeRemovalRisk(both), "dirty+detached");
  const partial = { ...confirmState(both), confirmDiscardChanges: true };
  assert.equal(canConfirmWorktreeRemoval(partial), false);
});

test("阻塞优先级：当前 > 运行中 > locked > 不可达 > 风险未知", () => {
  const p = preview();
  assert.equal(
    resolveWorktreeRemovalBlock(p, facts({ isCurrent: true, hasRunning: true })),
    "current",
  );
  assert.equal(
    resolveWorktreeRemovalBlock(preview({ isLocked: true }), facts({ hasRunning: true })),
    "running",
  );
  assert.equal(resolveWorktreeRemovalBlock(preview({ isLocked: true }), facts()), "locked");
  assert.equal(
    resolveWorktreeRemovalBlock(preview({ isReachable: false }), facts()),
    "unreachable",
  );
  assert.equal(
    resolveWorktreeRemovalBlock(preview({ scanComplete: false }), facts()),
    "risk-unknown",
  );
  assert.equal(resolveWorktreeRemovalBlock(preview(), facts()), null);
  const blocked = confirmState(preview({ isLocked: true }));
  assert.equal(canConfirmWorktreeRemoval(blocked), false);
});

test("extractWorktreeRemovalIssue 只从 error.data 读取载荷", () => {
  const latest = preview({ totalChangeCount: 2 });
  const error = Object.assign(new Error("changed"), {
    code: "status-changed",
    data: { code: "status-changed", message: "changed", latestPreview: latest },
  });
  assert.deepEqual(extractWorktreeRemovalIssue(error), {
    code: "status-changed",
    message: "changed",
    latestPreview: latest,
  });
  assert.equal(extractWorktreeRemovalIssue(new Error("plain")), null);
  assert.equal(extractWorktreeRemovalIssue({ data: { code: 1 } }), null);
});
