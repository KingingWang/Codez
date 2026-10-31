import type { ICodexNativeProviderKeyService } from "./contract.js";

/** 只读取配置标记和变量名，不读取、打印或伪造 Key。 */
export function providerKeyStateExample(service: ICodexNativeProviderKeyService) {
  return service.getKeyState({ providerId: "example-provider" });
}
