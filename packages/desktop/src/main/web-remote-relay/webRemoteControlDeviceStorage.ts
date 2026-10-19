import type { AppSettings } from "@codez/shared";

import type { WebRemoteControlDeviceStorage } from "#src/main/web-remote-relay/contract.js";

export const WEB_REMOTE_CONTROL_E2EE_PAIRING_CREDENTIAL_KEY = "web-remote-control:e2ee:pairing-key";
export const DEFAULT_WEB_REMOTE_CONTROL_E2EE_PAGE_URL =
  "https://kingingwang.github.io/Codez/remote/v4/";

/** 页面发布源由桌面发行方决定，旧入口覆盖只供未打包的本地开发使用。 */
export function resolveWebRemoteControlPageUrl(options: {
  isPackaged: boolean;
  e2eeUrl?: string;
  legacyUrl?: string;
}): string {
  return (
    options.e2eeUrl?.trim() ||
    (!options.isPackaged ? options.legacyUrl?.trim() : undefined) ||
    DEFAULT_WEB_REMOTE_CONTROL_E2EE_PAGE_URL
  );
}

export function createWebRemoteControlDeviceStorage(dependencies: {
  loadSettings(): Promise<AppSettings>;
  patchSettings(patch: Partial<AppSettings>): Promise<void>;
  deleteLegacyCredential(): Promise<void>;
  loadE2eeKey?(): Promise<string | null | undefined>;
  saveE2eeKey?(key: string): Promise<void>;
}): WebRemoteControlDeviceStorage {
  let migration: Promise<void> | undefined;
  return {
    load: async () => (await dependencies.loadSettings()).webRemoteControlRelayV2Device,
    save: (device) => dependencies.patchSettings({ webRemoteControlRelayV2Device: device }),
    ...(dependencies.loadE2eeKey && dependencies.saveE2eeKey
      ? {
          loadE2eeKey: async () => (await dependencies.loadE2eeKey!())?.trim() || undefined,
          saveE2eeKey: async (key: string) => {
            await dependencies.saveE2eeKey!(key);
          },
        }
      : {}),
    clearLegacy: () => {
      migration ??= (async () => {
        await dependencies.deleteLegacyCredential();
        await dependencies.patchSettings({ webRemoteControlExternalRelayDevice: undefined });
      })().catch((error) => {
        migration = undefined;
        throw error;
      });
      return migration;
    },
  };
}
