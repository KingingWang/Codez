import type {
  ProviderProvisioningEnvelope,
  ProviderProvisioningResult,
  ProviderRuntimeApiKeyInstall,
  CodexNativeProviderKeyInstall,
} from "@codez/shared";
import { ServiceChannels } from "@codez/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 仅供 Window Host 调用的远端 Environment target，不加入 IServiceAccessor。 */
export interface IProviderProvisioningTargetService {
  apply(
    envelope: ProviderProvisioningEnvelope,
  ): Promise<ProviderProvisioningResult>;
  /** 旧 Target 兼容；临时 Key 模式缺少该能力时必须拒绝连接。 */
  installRuntimeApiKeys?(input: ProviderRuntimeApiKeyInstall): Promise<void>;
  /**
   * Codex 原生临时 Key（spec: codex-provider-runtime-env-key）：进入跨连接轮换屏障，
   * 停止旧 Agent 并让全部托管供应商 fail-closed，直到 installCodexProviderKeys 解除。
   */
  beginCodexProviderKeyRotation?(): Promise<void>;
  /** 旧 Target 兼容；存在 App 托管引用而缺少该能力时必须拒绝。 */
  installCodexProviderKeys?(
    input: CodexNativeProviderKeyInstall,
  ): Promise<void>;
}

export const IProviderProvisioningTargetService =
  createServiceDescriptor<IProviderProvisioningTargetService>(
    ServiceChannels.ProviderProvisioningTarget,
  );
