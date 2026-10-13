import { describe, expect, it, vi } from "vitest";
import { createRemoteProviderProvisioningExecutor } from "../src/host/remoteProviderProvisioningService.js";

describe("Remote Provider Provisioning Host facade", () => {
  it("旧 Target 只配置文件模式时无需调用不存在的临时安装 RPC", async () => {
    const source = {
      readRuntimeApiKeys: vi.fn(async () => ({
        configFingerprint: "1".repeat(64),
        keys: [],
      })),
    };
    const target = {
      installRuntimeApiKeys: vi.fn(async () => {
        throw new Error("Unknown method");
      }),
    };
    const service = createRemoteProviderProvisioningExecutor({
      source: source as never,
      target: target as never,
    });

    await expect(service.installLocalRuntimeKeys()).resolves.toBeUndefined();
    expect(target.installRuntimeApiKeys).not.toHaveBeenCalled();
  });

  it("同一连接从临时模式切回配置文件后清除远端内存 Key", async () => {
    const source = {
      readRuntimeApiKeys: vi
        .fn()
        .mockResolvedValueOnce({
          configFingerprint: "1".repeat(64),
          keys: [{ name: "CODEZ_MODEL_API_KEY_ABC123", value: "ephemeral" }],
        })
        .mockResolvedValueOnce({ configFingerprint: "2".repeat(64), keys: [] }),
    };
    const target = { installRuntimeApiKeys: vi.fn(async () => {}) };
    const service = createRemoteProviderProvisioningExecutor({
      source: source as never,
      target: target as never,
    });

    await service.installLocalRuntimeKeys();
    await service.installLocalRuntimeKeys();
    expect(target.installRuntimeApiKeys).toHaveBeenNthCalledWith(2, {
      configFingerprint: "2".repeat(64),
      keys: [],
    });
  });

  it("同一连接的两轮 Key 更新串行读取和安装，迟到旧 RPC 不覆盖新值", async () => {
    let releaseFirst!: () => void;
    const firstInstall = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const source = {
      readRuntimeApiKeys: vi
        .fn()
        .mockResolvedValueOnce({
          configFingerprint: "1".repeat(64),
          keys: [{ name: "CODEZ_MODEL_API_KEY_ABC123", value: "old" }],
        })
        .mockResolvedValueOnce({
          configFingerprint: "1".repeat(64),
          keys: [{ name: "CODEZ_MODEL_API_KEY_ABC123", value: "new" }],
        }),
    };
    const target = {
      installRuntimeApiKeys: vi
        .fn()
        .mockImplementationOnce(() => firstInstall)
        .mockResolvedValueOnce(undefined),
    };
    const service = createRemoteProviderProvisioningExecutor({
      source: source as never,
      target: target as never,
    });

    const older = service.installLocalRuntimeKeys();
    const newer = service.installLocalRuntimeKeys();
    await vi.waitFor(() => expect(target.installRuntimeApiKeys).toHaveBeenCalledTimes(1));
    expect(source.readRuntimeApiKeys).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([older, newer]);
    expect(target.installRuntimeApiKeys.mock.calls.map(([input]) => input.keys[0].value)).toEqual([
      "old",
      "new",
    ]);
  });

  it("Server remote 在发送 v3 配置和 Key 前拒绝临时模式", async () => {
    const source = {
      read: vi.fn(async () => ({ syncId: "server-v3", schemaVersion: 3 })),
      readRuntimeApiKeys: vi.fn(async () => [
        {
          name: "CODEZ_MODEL_API_KEY_ABC123",
          value: "never-send-to-server",
        },
      ]),
    };
    const target = {
      apply: vi.fn(),
      installRuntimeApiKeys: vi.fn(),
    };
    const service = createRemoteProviderProvisioningExecutor({
      source: source as never,
      target: target as never,
      allowRuntimeApiKeys: false,
    });

    await expect(service.syncLocalToRemote()).resolves.toMatchObject({
      status: "unsupported",
      errorCode: "capability-unavailable",
    });
    await expect(service.installLocalRuntimeKeys()).rejects.toThrow(/Server remote/u);
    expect(target.apply).not.toHaveBeenCalled();
    expect(target.installRuntimeApiKeys).not.toHaveBeenCalled();
    expect(source.readRuntimeApiKeys).not.toHaveBeenCalled();
  });

  it("成功结果不携带远端附加的未知错误码，避免 Host schema 丢弃成功回包", async () => {
    const service = createRemoteProviderProvisioningExecutor({
      source: { read: vi.fn(async () => ({ syncId: "fixture" })) } as never,
      target: {
        apply: vi.fn(async () => ({
          syncId: "fixture",
          status: "applied",
          personalProviderCount: 0,
          credentialCount: 0,
          rolledBack: false,
          errorCode: "token=fixture-secret",
        })),
      } as never,
    });
    const result = await service.syncLocalToRemote();
    expect(result.status).toBe("applied");
    expect(result).not.toHaveProperty("errorCode");
  });

  it.each(["source", "target"])("%s 抛错保留安全的失败阶段", async (stage) => {
    const source = {
      read: vi.fn(async () => {
        if (stage === "source") throw new Error("token=fixture-secret");
        return { syncId: "fixture" };
      }),
    };
    const target = {
      apply: vi.fn(async () => {
        throw new Error("token=fixture-secret");
      }),
    };
    const service = createRemoteProviderProvisioningExecutor({ source: source as never, target });
    expect(await service.syncLocalToRemote()).toMatchObject({
      status: "failed",
      errorCode: stage === "source" ? "source-read-failed" : "target-call-failed",
    });
    expect(target.apply).toHaveBeenCalledTimes(stage === "source" ? 0 : 1);
  });

  it.each([undefined, "target-refresh-failed", "token=fixture-secret"])(
    "目标错误码 %s 只透传 allowlist；兼容旧目标",
    async (errorCode) => {
      const target = {
        apply: vi.fn(async () => ({
          syncId: "fixture",
          status: "failed",
          personalProviderCount: 0,
          credentialCount: 0,
          rolledBack: true,
          errorCode,
        })),
      };
      const service = createRemoteProviderProvisioningExecutor({
        source: { read: vi.fn(async () => ({ syncId: "fixture" })) } as never,
        target: target as never,
      });
      expect(await service.syncLocalToRemote()).toMatchObject({
        status: "failed",
        errorCode: errorCode === "target-refresh-failed" ? errorCode : "target-apply-failed",
      });
    },
  );

  it("does not send a secret when the target is unsupported", async () => {
    const source = { read: vi.fn() };
    const service = createRemoteProviderProvisioningExecutor({ source, target: undefined });

    await expect(service.syncLocalToRemote()).resolves.toMatchObject({
      status: "unsupported",
      rolledBack: false,
    });
    expect(source.read).not.toHaveBeenCalled();
  });

  it("reads and applies one complete source envelope", async () => {
    const envelope = { syncId: "source-sync" };
    const source = { read: vi.fn(async () => envelope) };
    const target = {
      apply: vi.fn(async (envelope: unknown) => ({
        syncId: (envelope as { syncId: string }).syncId,
        status: "applied" as const,
        personalProviderCount: 1,
        credentialCount: 1,
        registryRevision: "target-1",
        rolledBack: false,
      })),
    };
    const service = createRemoteProviderProvisioningExecutor({ source, target });

    await expect(service.syncLocalToRemote()).resolves.toMatchObject({
      status: "applied",
      syncId: "source-sync",
    });
    expect(source.read).toHaveBeenCalledOnce();
    expect(target.apply).toHaveBeenCalledWith(envelope);
  });

  it("always applies the complete local snapshot without a remote existence preflight", async () => {
    const envelope = { syncId: "source-sync" };
    const source = { read: vi.fn(async () => envelope) };
    const target = {
      apply: vi.fn(async () => ({
        syncId: envelope.syncId,
        status: "applied" as const,
        personalProviderCount: 0,
        credentialCount: 0,
        rolledBack: false,
      })),
    };
    const service = createRemoteProviderProvisioningExecutor({ source, target });

    await service.syncLocalToRemote();

    expect(target.apply).toHaveBeenCalledWith(envelope);
  });
});
