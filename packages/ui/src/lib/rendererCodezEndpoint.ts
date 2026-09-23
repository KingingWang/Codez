import {
  buildRuntimeCodezEndpointUrls,
  CODEZ_ENV,
  type RuntimeCodezEndpointEnv,
} from "@codez/shared";

interface RendererImportMetaEnv {
  VITE_CODEZ_BASE_URL?: string;
  VITE_CODEZ_ENDPOINT_ORIGIN?: string;
}

function readRendererImportMetaEnv(): RendererImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: RendererImportMetaEnv }).env ??
    {}) as RendererImportMetaEnv;
}

function createRendererCodezEndpointEnv(
  env: RendererImportMetaEnv = readRendererImportMetaEnv(),
): RuntimeCodezEndpointEnv {
  return {
    CODEZ_ENV,
    // UI 侧的 codez-plan 占位 provider 以前只看 CODEZ_ENV，
    // 没有消费 Vite 注入的 base url，导致自定义测试域名时 renderer 和 host/service 可能不一致。
    CODEZ_BASE_URL: env.VITE_CODEZ_BASE_URL,
    CODEZ_ENDPOINT_ORIGIN: env.VITE_CODEZ_ENDPOINT_ORIGIN,
  };
}

export const RENDERER_CODEZ_ENDPOINT_URLS = buildRuntimeCodezEndpointUrls(
  createRendererCodezEndpointEnv(),
);
