import type { CodezSessionStateSnapshot } from "@codez/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { repairImportedClaudeSessionSnapshot } from "#src/session/claude-native/importedClaudeHistoryRepair.js";
import type { ICodezAgentService } from "#src/codez-agent/codezAgent.js";
import type {
  CodezSessionReadParams,
  CodezSessionResumeParams,
} from "#src/codez-session/codezSession.js";

const logger = createServiceLogger("codez-session-service");

export async function repairEmptyImportedClaudeSessionSnapshot(params: {
  agentService: ICodezAgentService;
  snapshot: CodezSessionStateSnapshot;
  target: CodezSessionResumeParams | CodezSessionReadParams;
}): Promise<CodezSessionStateSnapshot> {
  const repaired = await repairImportedClaudeSessionSnapshot({
    snapshot: params.snapshot,
    target: {
      workspacePath: params.target.workspacePath,
      workspaceIdentity: params.target.workspaceIdentity,
      taskId: params.target.sessionId,
      ...("mcpServers" in params.target && params.target.mcpServers
        ? { mcpServers: params.target.mcpServers }
        : {}),
    },
    createSession: (input) => params.agentService.createSession(input),
    onRepair: (history) => {
      logger.warn(
        undefined,
        `[codez-session-service] Claude 导入 session 历史异常，按 ${history.source} 回填 taskId=${params.target.sessionId}`,
      );
    },
  });
  return repaired ?? params.snapshot;
}
