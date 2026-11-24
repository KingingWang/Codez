import { downloadCodezBuiltinRelease, type CodezBuiltinDownloadResult } from "@codez/provider-node";
import type { ApiClient, CodezJwtTokenResolver } from "@codez/shared";

export interface FetchCodezBuiltinRemoteReleaseOptions {
  readonly apiClient: ApiClient;
  readonly endpointOrigin: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly signal?: AbortSignal;
  readonly resolveZcodeJwtToken?: CodezJwtTokenResolver;
  readonly reuseUrl?: string;
}

/** Services 仅注入既有网络装配；URL、预算与 Release 校验由 provider-node 唯一实现。 */
export async function fetchCodezBuiltinRemoteRelease(
  options: FetchCodezBuiltinRemoteReleaseOptions,
): Promise<CodezBuiltinDownloadResult> {
  return downloadCodezBuiltinRelease({
    endpointOrigin: options.endpointOrigin,
    appVersion: options.appVersion,
    platform: options.platform,
    signal: options.signal,
    resolveZcodeJwtToken: options.resolveZcodeJwtToken,
    request: (url, init) => options.apiClient.request(url, init),
    ...(options.reuseUrl ? { reuseUrl: options.reuseUrl } : {}),
  });
}
