import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { CreateWorktreeDialogBody } from "./CreateWorktreeDialog.js";
import type { WorktreeCreationFormState } from "./hooks/useWorktreeCreation.js";

function state(overrides: Partial<WorktreeCreationFormState> = {}): WorktreeCreationFormState {
  return {
    mode: "new-branch",
    branchName: "feature/new",
    startPoint: "main",
    targetPath: "/host/repo-worktrees/feature-new",
    targetPathTouched: false,
    branches: [
      {
        name: "main",
        isCurrent: true,
        upstreamName: null,
        commitHash: "a",
        commitTimestampMs: 1,
        worktreePath: null,
      },
      {
        name: "occupied",
        isCurrent: false,
        upstreamName: null,
        commitHash: "b",
        commitTimestampMs: 1,
        worktreePath: "/host/occupied",
      },
    ],
    currentBranchName: "main",
    isSourceDirty: true,
    preview: null,
    previewPending: false,
    previewSequence: 0,
    previewFingerprint: null,
    occupiedPath: null,
    phase: "editing",
    pending: false,
    operationId: null,
    error: null,
    openError: null,
    result: null,
    ...overrides,
  };
}

function renderDialog(current: WorktreeCreationFormState) {
  return renderToStaticMarkup(
    <CodezIntlProvider initialLocale="zh-CN">
      <CreateWorktreeDialogBody
        workspacePath="/host/repo"
        state={current}
        availability="ready"
        disabledReason={null}
        onModeChange={() => {}}
        onBranchNameChange={() => {}}
        onStartPointChange={() => {}}
        onTargetPathChange={() => {}}
        onSubmit={() => {}}
        onRetryOpen={() => {}}
        onCancel={() => {}}
        onOpenOccupied={() => {}}
      />
    </CodezIntlProvider>,
  );
}

test("worktree form renders branch modes, host preview facts, and isolation disclosures", () => {
  const html = renderDialog(
    state({
      preview: {
        workspacePath: "/host/repo/subdir",
        repoRoot: "/host/repo",
        gitCommonDir: "/host/repo/.git",
        mode: "new-branch",
        branchName: "feature/new",
        startPoint: "main",
        baselineCommit: "0123456789abcdef0123456789abcdef01234567",
        targetPath: "/host/repo-worktrees/feature-new",
        sourceBranchName: null,
        occupiedPath: null,
      },
    }),
  );

  assert.match(html, /创建独立工作区/);
  assert.match(html, /新分支/);
  assert.match(html, /已有分支/);
  assert.match(html, /起点分支/);
  assert.match(html, /保存位置/);
  assert.match(html, /0123456789abcdef/);
  assert.match(html, /未提交修改和未跟踪文件不会带入新目录/);
  assert.match(html, /不会复制 \.env 等本地配置，也不会执行初始化脚本/);
  assert.match(html, /\/host\/repo-worktrees\/feature-new/);
});

test("occupied existing branch shows the host path and explicit jump action", () => {
  const html = renderDialog(
    state({
      mode: "existing-branch",
      branchName: "occupied",
      occupiedPath: "/host/occupied",
      preview: {
        workspacePath: "/host/repo",
        repoRoot: "/host/repo",
        gitCommonDir: "/host/repo/.git",
        mode: "existing-branch",
        branchName: "occupied",
        startPoint: "occupied",
        baselineCommit: "b",
        targetPath: "/host/repo-worktrees/occupied",
        sourceBranchName: null,
        occupiedPath: "/host/occupied",
      },
    }),
  );

  assert.match(html, /分支 occupied 已被占用/);
  assert.match(html, /\/host\/occupied/);
  assert.match(html, /跳转到该工作区/);
});

test("occupied local branches remain visible as a new-branch start point", () => {
  const html = renderDialog(
    state({
      mode: "new-branch",
      startPoint: "occupied",
      preview: {
        workspacePath: "/host/repo",
        repoRoot: "/host/repo",
        gitCommonDir: "/host/repo/.git",
        mode: "new-branch",
        branchName: "feature/new",
        startPoint: "occupied",
        baselineCommit: "a",
        targetPath: "/host/repo-worktrees/feature-new",
        sourceBranchName: null,
        occupiedPath: null,
      },
    }),
  );

  assert.match(html, /起点分支.*occupied/s);
});

test("unknown creation freezes inputs but keeps same-operation retry and cancel enabled", () => {
  const html = renderDialog(
    state({
      phase: "create-unknown",
      operationId: "same-operation",
      preview: {
        workspacePath: "/host/repo",
        repoRoot: "/host/repo",
        gitCommonDir: "/host/repo/.git",
        mode: "new-branch",
        branchName: "feature/new",
        startPoint: "main",
        baselineCommit: "0123456789abcdef0123456789abcdef01234567",
        targetPath: "/host/repo-worktrees/feature-new",
        sourceBranchName: "main",
        occupiedPath: null,
      },
    }),
  );
  assert.match(html, /<input[^>]*id="worktree-create-branch-name"[^>]*disabled/);
  assert.match(html, /<input[^>]*id="worktree-create-target-path"[^>]*disabled/);
  const retryButton = html.match(/<button[^>]*>按同一操作重试<\/button>/)?.[0];
  assert.ok(retryButton);
  assert.doesNotMatch(retryButton, /\sdisabled=/);
  const cancelButton = html.match(/<button[^>]*>取消<\/button>/)?.[0];
  assert.ok(cancelButton);
  assert.doesNotMatch(cancelButton, /\sdisabled=/);
});

test("created result with open failure offers only open retry", () => {
  const html = renderDialog(
    state({
      phase: "created",
      openError: "open failed",
      result: {
        workspacePath: "/host/repo-worktrees/feature-new",
        branchName: "feature/new",
        baselineCommit: "0123456789abcdef0123456789abcdef01234567",
        created: true,
      },
    }),
  );

  assert.match(html, /工作区已创建，打开失败/);
  assert.match(html, /open failed/);
  assert.match(html, /重试打开/);
  assert.doesNotMatch(html, /创建工作区/);
});

test("unknown result keeps the confirmed request immutable but retryable", () => {
  const html = renderDialog(
    state({
      phase: "create-unknown",
      error: "connection lost",
      preview: {
        workspacePath: "/host/repo",
        repoRoot: "/host/repo",
        gitCommonDir: "/host/repo/.git",
        mode: "new-branch",
        branchName: "feature/new",
        startPoint: "main",
        baselineCommit: "a",
        targetPath: "/host/repo-worktrees/feature-new",
        sourceBranchName: null,
        occupiedPath: null,
      },
    }),
  );

  assert.match(html, /创建结果未知/);
  assert.match(html, /按同一操作重试/);
  assert.match(html, /connection lost/);
  assert.match(html, /\/host\/repo-worktrees\/feature-new/);
  const disabledControls = html.match(/disabled(?:="")?/g) ?? [];
  assert.ok(disabledControls.length >= 4);
  assert.match(html, />取消</);
});

test("pending creation disables all editable inputs and close or cancel actions", () => {
  const html = renderDialog(
    state({
      pending: true,
      phase: "creating",
      preview: {
        workspacePath: "/host/repo",
        repoRoot: "/host/repo",
        gitCommonDir: "/host/repo/.git",
        mode: "new-branch",
        branchName: "feature/new",
        startPoint: "main",
        baselineCommit: "a",
        targetPath: "/host/repo-worktrees/feature-new",
        sourceBranchName: null,
        occupiedPath: null,
      },
    }),
  );

  const disabledControls = html.match(/disabled(?:="")?/g) ?? [];
  assert.ok(disabledControls.length >= 5);
  assert.match(html, /正在创建…/);
  assert.match(html, />取消</);
  assert.ok(disabledControls.length >= 5);
});
