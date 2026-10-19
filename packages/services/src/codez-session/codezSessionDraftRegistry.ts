import type { CodezSessionStateSnapshot } from "@codez/shared";
import type {
  CodezSessionWorkspaceTarget,
  CodezTaskTarget,
} from "#src/codez-session/codezSession.js";

function getWorkspaceKey(target: CodezSessionWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function getSessionScopedKey(target: CodezTaskTarget): string {
  return `${getWorkspaceKey(target)}\0${target.sessionId}`;
}

export function createCodezDeferredDraftRegistry() {
  const sessionKeys = new Set<string>();

  return {
    remember(params: CodezSessionWorkspaceTarget, snapshot: CodezSessionStateSnapshot): void {
      sessionKeys.add(
        getSessionScopedKey({
          workspacePath: snapshot.session.workspace.workspacePath,
          workspaceIdentity:
            snapshot.session.workspace.workspaceIdentity ?? params.workspaceIdentity,
          sessionId: snapshot.session.sessionId,
        }),
      );
    },

    has(target: CodezTaskTarget): boolean {
      return sessionKeys.has(getSessionScopedKey(target));
    },

    forget(target: CodezTaskTarget): void {
      sessionKeys.delete(getSessionScopedKey(target));
    },
  };
}
