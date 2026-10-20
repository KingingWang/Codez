import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitBranchDeletePreview } from "@codez/shared";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { DeleteBranchDialogBody } from "./DeleteBranchDialog.js";
import {
  createInitialBranchDeletionState,
  type BranchDeletionState,
} from "./hooks/branchDeletionModel.js";

function preview(overrides: Partial<GitBranchDeletePreview> = {}): GitBranchDeletePreview {
  return {
    branchName: "feature/old",
    isCurrent: false,
    checkedOutPath: null,
    isMerged: true,
    commitHash: "abc1234def",
    commitSubject: "feat: old thing",
    upstreamName: null,
    ...overrides,
  };
}

function state(p: GitBranchDeletePreview | null, overrides: Partial<BranchDeletionState> = {}) {
  return {
    ...createInitialBranchDeletionState(),
    phase: (p ? "confirm" : "previewing") as BranchDeletionState["phase"],
    preview: p,
    ...overrides,
  };
}

function render(current: BranchDeletionState) {
  return renderToStaticMarkup(
    <CodezIntlProvider initialLocale="zh-CN">
      <DeleteBranchDialogBody
        state={current}
        onForceConfirmedChange={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
        onRetry={() => {}}
        onJumpToWorkspace={() => {}}
      />
    </CodezIntlProvider>,
  );
}

test("已合并分支：显示最近提交与已合并状态，可直接删除", () => {
  const html = render(state(preview()));
  assert.match(html, /feature\/old/);
  assert.match(html, /abc1234 feat: old thing/);
  assert.match(html, /已合并/);
  assert.match(html, /远端跟踪分支不受影响/);
  assert.match(html, /删除分支/);
  assert.doesNotMatch(html, /我已知晓未合并提交/);
});

test("未合并分支：勾选强删确认前确认按钮禁用", () => {
  const unmerged = render(state(preview({ isMerged: false })));
  assert.match(unmerged, /包含未合并提交/);
  assert.match(unmerged, /我已知晓未合并提交将从分支引用中移除/);
  assert.match(unmerged, /<button[^>]*disabled=""[^>]*>\s*删除分支/s);
  const confirmed = render(state(preview({ isMerged: false }), { forceConfirmed: true }));
  assert.doesNotMatch(confirmed, /<button[^>]*disabled=""[^>]*>\s*删除分支/s);
});

test("占用分支：阻塞态显示占用路径与跳转，且无确认按钮", () => {
  const html = render(state(preview({ checkedOutPath: "/repo-worktrees/a" })));
  assert.match(html, /正被 \/repo-worktrees\/a 检出/);
  assert.match(html, /跳转到该工作区/);
  assert.doesNotMatch(html, />删除分支<\/button>/s);
});

test("branch-moved 提示与当前分支阻塞", () => {
  const moved = render(state(preview(), { notice: "branch-moved" }));
  assert.match(moved, /分支在你确认期间被推进/);
  const current = render(state(preview({ isCurrent: true })));
  assert.match(current, /不能删除当前分支/);
});
