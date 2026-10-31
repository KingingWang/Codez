import type { CodezProductFlavor } from "@codez/shared";

export interface DesktopUpdatePolicy {
  automatic: boolean;
}

export interface CodexGitHubUpdateFeedOptions {
  provider: "github";
  owner: string;
  repo: string;
  channel: string;
}

export interface DesktopRemoteAssetDirectoryInput {
  isPackaged: boolean;
  resourcesPath: string;
  desktopRoot: string;
  cacheDir: string;
}

export interface DesktopRemoteAssetDirectories {
  packagedRemoteAssetsDir: string;
  remoteCacheDir: string;
}

export interface DesktopProductRuntimePort {
  resolveDesktopApplicationName(flavor: CodezProductFlavor, isPackaged: boolean): string;
  resolveDesktopDataBaseDir(
    configured: string | null | undefined,
    home?: string,
    flavor?: CodezProductFlavor,
  ): string;
  resolveDesktopBootstrapSettingsFile(home?: string, flavor?: CodezProductFlavor): string;
  resolveDesktopUpdatePolicy(flavor?: CodezProductFlavor): DesktopUpdatePolicy;
  resolveCodexGitHubUpdateFeedOptions(arch: string): CodexGitHubUpdateFeedOptions;
  resolveCodexRemoteAssetDirs(
    input: DesktopRemoteAssetDirectoryInput,
  ): DesktopRemoteAssetDirectories;
}
