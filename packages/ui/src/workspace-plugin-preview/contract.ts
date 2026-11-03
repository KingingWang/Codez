import type { ComposerMentionPrefill } from "@/store/codezSessionStoreTypes.js";

/** Workspace catalog preview; selection emits a canonical mention without installing plugins. */
export interface WorkspacePluginPreviewProps {
  onOpen: () => void;
  onSelectPlugin: (mention: ComposerMentionPrefill) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}
