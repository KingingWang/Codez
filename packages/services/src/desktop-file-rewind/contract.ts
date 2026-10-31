import type { createCodexDesktopFileRewindService } from "../desktop-file-rewindService.js";

export type {
  ICodexDesktopFileRewindService,
  CodexDesktopFileRewindTarget,
  CodexDesktopFileRewindPreviewResult,
  CodexDesktopFileRewindApplyParams,
  CodexDesktopFileRewindStatus,
  CodexDesktopFileRewindFailureReason,
  CodexDesktopFileRewindProjectionOverlayParams,
} from "../desktop-file-rewind.js";

export type CreateCodexDesktopFileRewindService = typeof createCodexDesktopFileRewindService;
