import { createLocalServices, getAppConfigDir } from "@codez/services/node";
import {
  materializeBundledCodezBuiltinProviderConfig,
  readBundledCodezBuiltinProviderConfig,
} from "./bundledCodezBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";

async function main(): Promise<void> {
  const codezBuiltinProviderConfigFilePath = await materializeBundledCodezBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledCodezBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["CODEZ_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["CODEZ_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["CODEZ_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  const services = createLocalServices({
    codezBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
  });

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[codez-server:http] startup failed", error);
  process.exitCode = 1;
});
