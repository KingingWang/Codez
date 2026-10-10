import { Event } from "@codez/rpc";
import {
  isModelSelectionViewForWorkspace,
  type CodezAgentV4ClientMode,
  type IModelSelectionService,
} from "@codez/services";
import { resolveWorkspaceKey, type WindowHostAttachmentScope } from "@codez/shared";

/** 连接边界适配；模型配置、目录与 revision 仍由原 Host service 持有。 */
export function scopeModelSelectionServiceForAttachment(
  service: IModelSelectionService,
  clientMode: CodezAgentV4ClientMode,
  scope: WindowHostAttachmentScope,
): IModelSelectionService {
  if (clientMode !== "web-remote-replayable" || !scope.workspacePath) return service;
  const workspace = Object.freeze({
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
  });
  const workspaceKey = resolveWorkspaceKey(workspace);
  return {
    onDidChange: Event.filter(service.onDidChange, (view) =>
      isModelSelectionViewForWorkspace(view, workspaceKey),
    ),
    async getView(input) {
      if (input?.workspace && resolveWorkspaceKey(input.workspace) !== workspaceKey) {
        throw new Error("Model selection workspace does not match mobile attachment");
      }
      // Bugfix：上游手机页只传 selection；缺少 workspace 会令 Codex 返回空目录并禁用发送。
      // 从已鉴权 attachment 补齐身份，不能用进程 cwd 或最后活跃工作区猜目标。
      return service.getView({ ...input, selection: input?.selection ?? null, workspace });
    },
  };
}
