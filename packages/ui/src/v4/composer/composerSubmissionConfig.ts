import { resolveExecutionState, type ModelSelection } from "@codez/shared";
import { submissionModeSchema, type SubmissionMode } from "@codez/shared/codez-protocol-v4";
import type { ModelSelectionView } from "@codez/services";
import { validateModelSelectionOptions } from "@codez/provider";
import {
  isCodexSelectionReady,
  type CodexModelCatalog,
} from "@/settings/codex/codexModelCatalog.js";

export interface ComposerSubmissionConfig {
  modelSelection: ModelSelection;
  mode: SubmissionMode;
  planEnabled: boolean;
}

/**
 * 权限档冻结映射（specs/codex-permission-modes.md）：
 * - plan 是独立勾选维度；旧草稿的 mode:"plan" 提交前落到权限档默认值
 *   （Codex = custom 跟随 config.toml，Codez Agent = build）。持久化的 plan 草稿
 *   在 readDraft 边界已迁移为 build+planEnabled，这里兜底内存态残留。
 * - custom 只属于 Codex 链路；非 Codex 提交（如运行时切换的残留草稿）回退 build，
 *   防止 Codez Agent 协议面收到不认识的档位（其 admission 会显式拒绝）。
 */
export function freezeSubmissionMode(
  mode: SubmissionMode,
  codexCatalog: CodexModelCatalog | undefined,
): SubmissionMode {
  if (mode === "plan") return codexCatalog ? "custom" : "build";
  if (mode === "custom" && !codexCatalog) return "build";
  return mode;
}

/** 在点击提交的瞬间，把 Composer 意图冻结成本次 Submission 的执行配置。 */
export function createComposerSubmissionConfig(
  composer:
    | { mode?: string; planEnabled?: boolean; modelSelection?: ModelSelection }
    | null
    | undefined,
  view: ModelSelectionView | null,
  codexCatalog?: CodexModelCatalog,
): ComposerSubmissionConfig | null {
  // 只读子会话和未挂载 Composer 的 SessionPane 不提供草稿；这类场景没有可提交配置，
  // 不能因为渲染提交门禁而读取 undefined 并让整个会话区域崩溃。
  if (!composer) {
    return null;
  }
  const selection = composer.modelSelection;
  const mode = submissionModeSchema.safeParse(composer.mode);
  const model =
    selection &&
    view?.providers
      .find((provider) => provider.providerId === selection.providerId)
      ?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (
    !mode.success ||
    !selection ||
    (codexCatalog
      ? !isCodexSelectionReady(codexCatalog, selection)
      : !model || !validateModelSelectionOptions(model, selection).ok)
  )
    return null;
  // 不读取 Session 或显示别名；复制所有选择叶子，防止 await 后用户切模改变本次请求。
  return Object.freeze({
    mode: freezeSubmissionMode(mode.data, codexCatalog),
    planEnabled: resolveExecutionState(composer).planEnabled,
    modelSelection: Object.freeze({
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(selection.options?.reasoningLevel
        ? { options: Object.freeze({ reasoningLevel: selection.options.reasoningLevel }) }
        : {}),
    }),
  });
}
