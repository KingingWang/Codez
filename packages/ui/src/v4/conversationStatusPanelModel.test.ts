import assert from "node:assert/strict";
import test from "node:test";
import type { GitRepositorySummary } from "@codez/shared";
import { buildConversationStatusPanelModel } from "./conversationStatusPanelModel.js";

const repository: GitRepositorySummary = {
  workspacePath: "/fixture/project",
  repoRoot: "/fixture/project",
  workspaceInRepoPath: "",
  autoRefreshWatchPaths: [],
  branchName: "main",
  trackingBranchName: "origin/main",
  headRefType: "branch",
  ahead: 0,
  behind: 0,
  isDirty: false,
  isGitAvailable: true,
  isRepository: true,
};

test("Git tools stay available without line-level changes, including clean and ahead repositories", () => {
  for (const gitSummary of [
    repository,
    { ...repository, ahead: 2 },
    { ...repository, isDirty: true },
  ]) {
    const model = buildConversationStatusPanelModel({
      gitSummary,
      gitWorktreeChangeSummary: { added: 0, removed: 0 },
    });
    assert.equal(model.hasContent, true);
    assert.equal(model.git?.ahead, gitSummary.ahead);
  }
});

test("Git tools remain hidden when Git is unavailable, absent or Office mode is active", () => {
  for (const input of [
    { gitSummary: { ...repository, isRepository: false } },
    { gitSummary: { ...repository, isGitAvailable: false } },
    { gitSummary: repository, isOfficeMode: true },
  ]) {
    const model = buildConversationStatusPanelModel(input);
    assert.equal(model.git, null);
    assert.equal(model.hasContent, false);
  }
});
