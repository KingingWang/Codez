import type { ICodezAgentService } from "./codez-agent/codezAgent.js";
import { buildRewindPreview, resolveRewindFilePath } from "./desktop-file-rewindPatch.js";
import { readCodexFileRewindRegularTextFile } from "./desktop-file-rewindFiles.js";
import type {
  CodexDesktopFileRewindStatus,
  CodexDesktopFileRewindTarget,
} from "./desktop-file-rewind.js";

export type CodexDesktopFileRewindAgentService = Pick<
  ICodezAgentService,
  | "conversationFileChangesV4"
  | "conversationFileRewindProjectionOverlayV4"
  | "conversationRowsRangeV4"
  | "helloConversationV4"
>;

type Failure = (reason: CodexDesktopFileRewindStatus["reason"], message: string) => never;

export function createCodexDesktopFileRewindPlans(options: {
  agentService: CodexDesktopFileRewindAgentService;
  failure: Failure;
}) {
  return async (target: CodexDesktopFileRewindTarget) => {
    const workspace = {
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity?.trim()
        ? { workspaceIdentity: target.workspaceIdentity?.trim() }
        : {}),
    };
    const projection = await options.agentService.conversationFileChangesV4({
      ...workspace,
      sessionId: target.sessionId,
      target: target.target,
      baseRevision: target.baseRevision,
      baseLogEpoch: target.baseLogEpoch,
    });
    // Fetch exactly the guarded row without relying on its position in the current window.
    const snapshot = await options.agentService.conversationRowsRangeV4({
      ...workspace,
      sessionId: target.sessionId,
      beforeRowId: target.target.rowId + 1,
      limit: 1,
    });
    const overlayRow = snapshot.rows.find(
      (row) => row.rowId === target.target.rowId && row.entityId === target.target.entityId,
    );
    if (!overlayRow || overlayRow.kind !== "turnHeader")
      options.failure("target_missing", "File rewind turn no longer exists");
    const currentFiles = new Map<string, string>();
    for (const item of projection.items) {
      const absolutePath = resolveRewindFilePath(target.workspacePath, item.path);
      const content = absolutePath ? await readCodexFileRewindRegularTextFile(absolutePath) : null;
      if (absolutePath && content !== null) currentFiles.set(absolutePath, content);
    }
    return {
      preview: buildRewindPreview({
        currentFiles,
        workspacePath: target.workspacePath,
        projection,
      }),
      projection,
      turnId: overlayRow.turnId,
    };
  };
}
