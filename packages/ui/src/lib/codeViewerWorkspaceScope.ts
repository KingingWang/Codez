export interface CodeViewerWorkspaceScope {
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

export function scopeCodeViewerSource<T extends CodeViewerWorkspaceScope>(
  source: T,
  scope: CodeViewerWorkspaceScope,
): T {
  const workspacePath = source.workspacePath ?? scope.workspacePath;
  const workspaceIdentity = source.workspaceIdentity ?? scope.workspaceIdentity;
  const workspaceRemoteSessionId =
    source.workspaceRemoteSessionId ?? scope.workspaceRemoteSessionId;
  return {
    ...source,
    ...(workspacePath !== undefined ? { workspacePath } : {}),
    ...(workspaceIdentity !== undefined ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId !== undefined ? { workspaceRemoteSessionId } : {}),
  };
}
