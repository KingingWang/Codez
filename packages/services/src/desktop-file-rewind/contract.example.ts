import type {
  CodexDesktopFileRewindPreviewResult,
  ICodexDesktopFileRewindService,
} from "./contract.js";

/** 空投影不能被示例默认为可回退。 */
export const unavailableRewindPreviewExample = {
  canApply: false,
  safeFiles: [],
  unsafeFiles: [],
  ignoredFiles: [],
} satisfies CodexDesktopFileRewindPreviewResult;

export function rewindPreviewExample(
  service: ICodexDesktopFileRewindService,
  target: Parameters<ICodexDesktopFileRewindService["preview"]>[0],
) {
  return service.preview(target);
}
