import { buildRuntimeCodezApiUrl, resolveZaiBusinessBaseUrl } from "@codez/shared";

export const CODEZ_CLIENT_SCENES_URL = buildRuntimeCodezApiUrl(
  process.env,
  "/api/v1/client/scenes",
);

export const ZAI_API_HOST = resolveZaiBusinessBaseUrl(process.env);
