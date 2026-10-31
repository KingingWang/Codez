import { TOOL_DIFF_DISPLAY_MAX_HUNKS, TOOL_DIFF_DISPLAY_MAX_LINES } from "./contract.js";

export const toolDiffPreviewBudgetExample = {
  maxHunks: TOOL_DIFF_DISPLAY_MAX_HUNKS,
  maxLines: TOOL_DIFF_DISPLAY_MAX_LINES,
} as const;
