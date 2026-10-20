import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitWorktreeRemovalPreview } from "@codez/shared";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { RemoveWorktreeDialogBody } from "./RemoveWorktreeDialog.js";
import {
  createInitialWorktreeRemovalState,
  type WorktreeRemovalState,
  type WorktreeRemovalUiFacts,
} from "./hooks/worktreeRemovalModel.js";

function preview(overrides: Partial<GitWorktreeRemovalPreview> = {}): GitWorktreeRemovalPreview {
  return {
    targetPath: "/repo-worktrees/feature",
    branchName: "feature",
    isDetached: false,
    headCommitHash: "abc1234def",
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

function state(
  p: GitWorktreeRemovalPreview | null,
  overrides: Partial<WorktreeRemovalState> = {},
  uiFacts: Partial<WorktreeRemovalUiFacts> = {},
): WorktreeRemovalState {
  return {
    ...createInitialWorktreeRemovalState(),
    phase: p ? "confirm" : "previewing",
    preview: p,
    uiFacts: { isCurrent: false, openTabs: [], hasRunning: false, ...uiFacts },
    ...overrides,
  };
}

function render(current: WorktreeRemovalState) {
  return renderToStaticMarkup(
    <CodezIntlProvider initialLocale="zh-CN">
      <RemoveWorktreeDialogBody
        state={current}
        onConfirmDiscardChanges={() => {}}
        onConfirmDiscardDetachedHead={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
        onRetry={() => {}}
        onRetryUnknown={() => {}}
        onJumpToWorkspace={() => {}}
      />
    </CodezIntlProvider>,
  );
}

test("干净树：直接出现危险确认按钮且无勾选要求", () => {
  const html = render(state(preview()));
  assert.match(html, /永久删除该目录/);
  assert.doesNotMatch(html, /我已知晓/);
  assert.match(html, /\/repo-worktrees\/feature/);
});

test("ignored 敏感配置：列出关注区并强制勾选（审查①）", () => {
  const html = render(
    state(preview({ attentionPaths: [".env", ".npmrc"], attentionTotalCount: 2 })),
  );
  assert.match(html, /需要关注的本地配置（2）/);
  assert.match(html, /\.env/);
  assert.match(html, /我已知晓上述 2 项内容将被永久丢弃/);
  assert.match(
    html,
    /永久删除该目录[^<]*<\/button>|<button[^>]*disabled=""[^>]*>\s*永久删除该目录/s,
  );
});

test("脏树勾选后确认按钮可用；detached 风险独立勾选", () => {
  const dirty = state(
    preview({
      totalChangeCount: 1,
      changes: [
        {
          path: "/repo-worktrees/feature/a.ts",
          repoRelativePath: "a.ts",
          workspaceRelativePath: "a.ts",
          kind: "modified",
          section: "unstaged",
          added: 1,
          removed: 0,
          isStaged: false,
          isUntracked: false,
          isConflicted: false,
        },
      ],
    }),
    { confirmDiscardChanges: true },
  );
  const dirtyHtml = render(dirty);
  assert.match(dirtyHtml, /a\.ts/);
  assert.match(dirtyHtml, /<button[^>]*type="button"[^>]*>\s*永久删除该目录/s);

  const detached = state(
    preview({ branchName: null, isDetached: true, headReachableFromRef: false }),
    { confirmDiscardDetachedHead: true },
  );
  const detachedHtml = render(detached);
  assert.match(detachedHtml, /游离 HEAD（abc1234）/);
  assert.match(detachedHtml, /该 HEAD 提交不被任何分支引用/);
});

test("阻塞态：当前/运行中/locked/风险未知均不渲染确认按钮", () => {
  const cases: [WorktreeRemovalState, RegExp][] = [
    [state(preview(), {}, { isCurrent: true }), /正在使用的工作区/],
    [
      state(
        preview(),
        {},
        {
          hasRunning: true,
          openTabs: [
            { tabId: "t", workspacePath: "/repo-worktrees/feature", workspaceIdentity: null },
          ],
        },
      ),
      /运行中的任务/,
    ],
    [state(preview({ isLocked: true, lockReason: "mounted" })), /受保护/],
    [state(preview({ scanComplete: false })), /风险未知不等于没有风险/],
  ];
  for (const [s, pattern] of cases) {
    const html = render(s);
    assert.match(html, pattern);
    assert.doesNotMatch(html, /永久删除该目录/);
  }
});

test("status-changed 提示与结果未知态", () => {
  const changed = render(state(preview(), { notice: "status-changed" }));
  assert.match(changed, /已更新为最新清单/);
  const unknown = render(state(preview(), { phase: "result-unknown" }));
  assert.match(unknown, /删除结果未知/);
  assert.match(unknown, /按同一操作重试/);
});
