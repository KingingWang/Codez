import type { SubmissionMode } from "@codez/shared/codez-protocol-v4";

/**
 * 草稿权限档归一化（specs/codex-permission-modes.md「默认值与迁移边界」）。
 * 展示与提交共用同一推导，避免"菜单显示 A、提交冻结 B"的分裂。
 *
 * codex 草稿：
 * - `edit` 在 autoReviewApprovals 能力未确认（探测中/失败/旧 peer）时归一为
 *   `custom`，避免旧 edit 草稿被原生拒绝导致发送失败；
 * - 未携带新代标记（`permissionModeGen !== 2`）的 `build` 是升级前的存量草稿：
 *   旧 build 语义是"保留原生权限、不主动收紧"，与新 custom 等价。若原样下发，
 *   bridge 会把它当成显式选档（投影 custom ≠ build）而在下次提交时静默下发
 *   权限覆盖、改写线程权限——违背"存量草稿不重写、显示 custom"的迁移边界。
 *   新版本下用户显式选择的 build 携带标记，原样保留。
 *
 * 非 codex 草稿：
 * - `custom` 只属于 Codex 链路（Codez Agent 运行时没有该档位）；运行时切换等
 *   残留草稿落到非 Codex 链路时回退 `build`，防止协议面下发对方不认识的值。
 */
export function normalizeComposerDraftMode(
  draft: { mode?: SubmissionMode; permissionModeGen?: number },
  options: { codex: boolean; codexAutoReviewSupported: boolean },
): SubmissionMode | undefined {
  const { mode } = draft;
  if (!mode) return mode;
  if (options.codex) {
    if (mode === "edit" && !options.codexAutoReviewSupported) return "custom";
    if (mode === "build" && draft.permissionModeGen !== 2) return "custom";
    return mode;
  }
  return mode === "custom" ? "build" : mode;
}
