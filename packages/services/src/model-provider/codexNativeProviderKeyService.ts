import { ServiceChannels } from "@codez/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * Codex 原生自定义供应商「本机保存、临时环境变量」Key 的 Renderer 面
 * （spec: specs/codex-provider-runtime-env-key.md）。
 *
 * 实现运行在窗口 Host：本地 workspace 由 Local Host 提供，SSH/WSL/Docker
 * workspace 由窗口内 remote workspace collection 以本机 Credential Store 提供。
 * Server remote 不注册该服务（UI 以调用失败判定为不支持）。
 */
export interface ICodexNativeProviderKeyService {
  /** 只返回「是否已配置」与变量名，永不返回 Key 值。 */
  getKeyState(input: {
    providerId: string;
  }): Promise<{ configured: boolean; envName: string }>;
  /**
   * 保存事务第一步：远程 Environment 先建立跨连接屏障（停止旧 Agent 并拒绝新模型输入），
   * 再写本机凭据与注册表；config.toml 的 config/batchWrite 由调用方在两步之间完成。
   * runtime-env 返回 envName 供配置引用；apiKey 缺省时保留既有凭据。
   */
  prepareKeySource(input: {
    providerId: string;
    mode: "runtime-env" | "config-file" | "delete";
    apiKey?: string;
  }): Promise<{ envName?: string }>;
  /**
   * 保存事务第二步。commit=false 恢复旧凭据/注册表；两种结局都会把最新事实
   * 安装到每条在线连接并解除屏障（本地则重造活动 Codex runtime）。
   */
  finishKeySource(input: {
    providerId: string;
    commit: boolean;
  }): Promise<void>;
}

export const ICodexNativeProviderKeyService =
  createServiceDescriptor<ICodexNativeProviderKeyService>(
    ServiceChannels.CodexNativeProviderKey,
  );
