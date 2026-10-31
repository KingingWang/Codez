import type {
  CodexModelSelectionService,
  createCodexModelSelectionService,
} from "../codexModelSelectionService.js";

export type { ModelSelectionView, ModelSelectionViewInput } from "@codez/provider";
export type { CodexHostModelCatalog, CodexModelProviderGroup } from "../codexHostModelCatalog.js";
export type {
  CodexModelSelectionWorkspaceTarget,
  CodexModelSelectionRequestSender,
  CodexModelSelectionServiceOptions,
} from "../codexModelSelectionService.js";

export type CreateCodexModelSelectionService = typeof createCodexModelSelectionService;
export type CodexModelSelectionPort = Pick<
  CodexModelSelectionService,
  "getView" | "onDidChange" | "dispose"
>;
