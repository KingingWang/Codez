import { DEFAULT_CODEZ_ENDPOINT_ORIGIN } from "./codezEndpoint.js";

export const CODEZ_SOURCE_HEADERS = {
  "User-Agent": "Codez/unknown",
  "HTTP-Referer": DEFAULT_CODEZ_ENDPOINT_ORIGIN,
  "X-Title": "Z Code@electron",
} as const;

export interface BuildCodezSourceHeadersFromContextOptions {
  appVersion?: string;
  arch?: string;
  clientLanguage?: string;
  clientTimezone?: string;
  deviceMid?: string;
  endpointOrigin?: string;
  osVersion?: string;
  platform?: string;
  releaseChannel?: string;
  sourceTitle?: string;
}

export function normalizeCodezSourceHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[\x20-\x7e]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function buildCodezSourceHeadersFromContext(
  options: BuildCodezSourceHeadersFromContextOptions = {},
): Record<string, string> {
  const appVersion = normalizeCodezSourceHeaderValue(options.appVersion);
  const arch = normalizeCodezSourceHeaderValue(options.arch);
  const clientLanguage = normalizeCodezSourceHeaderValue(options.clientLanguage) ?? "unknown";
  const clientTimezone = normalizeCodezSourceHeaderValue(options.clientTimezone) ?? "unknown";
  const deviceMid = normalizeCodezSourceHeaderValue(options.deviceMid);
  const endpointOrigin =
    normalizeCodezSourceHeaderValue(options.endpointOrigin) ?? DEFAULT_CODEZ_ENDPOINT_ORIGIN;
  const osVersion = normalizeCodezSourceHeaderValue(options.osVersion);
  const platform = normalizeCodezSourceHeaderValue(options.platform);
  const releaseChannel = normalizeCodezSourceHeaderValue(options.releaseChannel);
  const sourceTitle = normalizeCodezSourceHeaderValue(options.sourceTitle) ?? "electron";

  return {
    ...CODEZ_SOURCE_HEADERS,
    "HTTP-Referer": endpointOrigin,
    "User-Agent": `Codez/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-Codez-App-Version": appVersion } : {}),
    "X-Title": `Z Code@${sourceTitle}`,
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    ...(releaseChannel ? { "X-Release-Channel": releaseChannel } : {}),
    "X-Client-Language": clientLanguage,
    "X-Client-Timezone": clientTimezone,
    ...(platform ? { "X-Os-Category": normalizeOsCategory(platform) } : {}),
    ...(osVersion ? { "X-Os-Version": osVersion } : {}),
    ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  };
}

function normalizeOsCategory(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
