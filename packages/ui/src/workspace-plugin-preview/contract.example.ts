import type { WorkspacePluginPreviewProps } from "./contract.js";
import type { resolvePluginIconSource } from "@/lib/pluginIconSource.js";

export const previewExample: WorkspacePluginPreviewProps = {
  workspacePath: "/workspace/project",
  onOpen: () => {},
  onSelectPlugin: (mention) => {
    void mention.markdown;
  },
};

/** 复用同一可信解析入口，不在 preview 或消息侧另写官方插件例外。 */
export function exampleTrustedPluginIcon(
  resolve: typeof resolvePluginIconSource,
  pluginId?: string,
  icon?: string,
): string | undefined {
  return resolve(pluginId, icon);
}
