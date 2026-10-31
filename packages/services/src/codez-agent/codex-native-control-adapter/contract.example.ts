import type {
  CreateCuaCredentialGrantPublisher,
  ResolveCuaCredentialGrantRootDirectory,
} from "./contract.js";

/** 只有合成路径；不创建 Helper、socket 或凭据文件。 */
export const grantPublisherOptionsExample = {
  grantRootDirectory: "/workspace/example/codez-data/computer-use/grants",
} satisfies Parameters<CreateCuaCredentialGrantPublisher>[0];

export function grantDirectoryExample(resolveRoot: ResolveCuaCredentialGrantRootDirectory): string {
  return resolveRoot("/workspace/example/codez-data");
}
