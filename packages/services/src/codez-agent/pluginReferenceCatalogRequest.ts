import {
  codezProtocolMethods,
  codezPluginsReferenceCatalogResultSchema,
  type CodezPluginsReferenceCatalogParams,
} from "@codez/shared";
import type { CodezProtocolClient } from "#src/codez-agent/codezProtocolClient.js";

/** 旧协议严格校验响应；新展示字段走独立入口，只有 -32601 能证明旧 Agent 不支持。 */
export async function requestPluginReferenceCatalog(
  client: Pick<CodezProtocolClient, "request">,
  params: CodezPluginsReferenceCatalogParams,
) {
  try {
    return await client.request(
      codezProtocolMethods.pluginsReferenceCatalogWithCategory,
      params,
      codezPluginsReferenceCatalogResultSchema,
    );
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === -32601))
      throw error;
    return client.request(
      codezProtocolMethods.pluginsReferenceCatalog,
      params,
      codezPluginsReferenceCatalogResultSchema,
    );
  }
}
