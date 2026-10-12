import type { ICredentialService } from "@codez/services";
import type { AppSettings } from "@codez/shared";

export const WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY =
  "web-remote-control:external-relay:pass_hash";
export const WEB_REMOTE_CONTROL_E2EE_PAIRING_CREDENTIAL_KEY = "web-remote-control:e2ee:pairing-key";

export interface WebRemoteControlRelayStoredAuth {
  deviceSid: string;
  passHash: string;
  e2eeKey?: string;
}

export interface WebRemoteControlRelayAuthStorageProvider {
  load(): Promise<WebRemoteControlRelayStoredAuth | undefined>;
  save(auth: WebRemoteControlRelayStoredAuth): Promise<void>;
  clear(): Promise<void>;
  rotate(auth: WebRemoteControlRelayStoredAuth): Promise<void>;
}

interface WebRemoteControlRelayAuthStorageDependencies {
  credentialService: Pick<ICredentialService, "load" | "save" | "delete">;
  loadSettings(): Promise<AppSettings>;
  patchSettings(patch: Partial<AppSettings>): Promise<void>;
  logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

function safeAuthLogFields(auth: Partial<WebRemoteControlRelayStoredAuth>) {
  const deviceSid = auth.deviceSid?.trim();
  return {
    hasDeviceSid: Boolean(deviceSid),
    deviceSidSuffix: deviceSid ? deviceSid.slice(-6) : undefined,
    hasPassHash: Boolean(auth.passHash?.trim()),
  };
}

export function createWebRemoteControlRelayAuthStorageProvider({
  credentialService,
  loadSettings,
  patchSettings,
  logger,
}: WebRemoteControlRelayAuthStorageDependencies): WebRemoteControlRelayAuthStorageProvider {
  const clear = async () => {
    await patchSettings({ webRemoteControlExternalRelayDevice: undefined });
    await credentialService.delete(WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY);
    await credentialService.delete(WEB_REMOTE_CONTROL_E2EE_PAIRING_CREDENTIAL_KEY);
    logger?.info("[web-remote-control] external relay auth cleared", {
      hasDeviceSid: false,
      hasPassHash: false,
    });
  };

  return {
    async load(): Promise<WebRemoteControlRelayStoredAuth | undefined> {
      const settings = await loadSettings();
      const deviceSid = settings.webRemoteControlExternalRelayDevice?.deviceSid.trim();
      const passHash = (
        await credentialService.load(WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY)
      )?.trim();
      const e2eeKey = (
        await credentialService.load(WEB_REMOTE_CONTROL_E2EE_PAIRING_CREDENTIAL_KEY)
      )?.trim();

      if (!deviceSid && !passHash && !e2eeKey) {
        return undefined;
      }

      if (!deviceSid || !passHash) {
        logger?.warn("[web-remote-control] external relay auth partial state cleared", {
          hasDeviceSid: Boolean(deviceSid),
          hasPassHash: Boolean(passHash),
        });
        await clear();
        return undefined;
      }

      logger?.info("[web-remote-control] external relay auth loaded", {
        ...safeAuthLogFields({ deviceSid, passHash }),
        hasE2eeKey: Boolean(e2eeKey),
      });
      return { deviceSid, passHash, ...(e2eeKey ? { e2eeKey } : {}) };
    },

    async save(auth: WebRemoteControlRelayStoredAuth): Promise<void> {
      if (auth.e2eeKey) {
        await credentialService.save(WEB_REMOTE_CONTROL_E2EE_PAIRING_CREDENTIAL_KEY, auth.e2eeKey);
      }
      await patchSettings({
        webRemoteControlExternalRelayDevice: { deviceSid: auth.deviceSid },
      });
      await credentialService.save(
        WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY,
        auth.passHash,
      );
      logger?.info("[web-remote-control] external relay auth saved", {
        ...safeAuthLogFields(auth),
        hasE2eeKey: Boolean(auth.e2eeKey),
      });
    },

    clear,

    async rotate(auth: WebRemoteControlRelayStoredAuth): Promise<void> {
      await clear();
      await this.save(auth);
      logger?.info("[web-remote-control] external relay auth rotated", {
        ...safeAuthLogFields(auth),
      });
    },
  };
}
