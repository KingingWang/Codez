import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexNativeProviderKeyInstall } from "@codez/shared";
import type { IProviderProvisioningTargetService } from "@codez/services";
import {
  createCredentialService,
  createCodexNativeProviderKeyService,
  codexNativeProviderKeyCredentialKey,
  codexNativeProviderKeyEnvName,
  setDataBaseDir,
} from "@codez/services/node";
import { createRemoteProviderProvisioningExecutor } from "../src/host/remoteProviderProvisioningService.js";

const tempDirs: string[] = [];

afterEach(() => {
  setDataBaseDir(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup(environmentKey = "ssh:acct@host:22") {
  const dir = mkdtempSync(join(tmpdir(), "codex-key-executor-"));
  tempDirs.push(dir);
  setDataBaseDir(dir);
  const credentialService = createCredentialService();
  return { environmentKey, credentialService };
}

function fakeTarget(overrides: Partial<IProviderProvisioningTargetService> = {}) {
  const calls: { begin: number; install: CodexNativeProviderKeyInstall[] } = {
    begin: 0,
    install: [],
  };
  const target: IProviderProvisioningTargetService = {
    apply:
      overrides.apply ??
      (async () => {
        throw new Error("unused");
      }),
    beginCodexProviderKeyRotation: async () => {
      calls.begin += 1;
    },
    installCodexProviderKeys: async (input) => {
      calls.install.push(input);
    },
    ...overrides,
  };
  return { target, calls };
}

describe("RemoteProviderProvisioningExecutor Codex 临时 Key", () => {
  it("installs current registry facts with local credential values", async () => {
    const { environmentKey, credentialService } = setup();
    const keyService = createCodexNativeProviderKeyService({
      environmentKey,
      credentialService,
    });
    await keyService.prepareKeySource({
      providerId: "acme",
      mode: "runtime-env",
      apiKey: "sk-live",
    });
    await keyService.finishKeySource({ providerId: "acme", commit: true });
    // 另一个供应商只有引用没有凭据：以 null 安装，远端据此 fail-closed。
    await keyService.prepareKeySource({
      providerId: "ghost",
      mode: "runtime-env",
      apiKey: "sk-ghost",
    });
    await keyService.finishKeySource({ providerId: "ghost", commit: true });
    await credentialService.delete(codexNativeProviderKeyCredentialKey(environmentKey, "ghost"));

    const { target, calls } = fakeTarget();
    const executor = createRemoteProviderProvisioningExecutor({
      target,
      codexKeys: { environmentKey, credentialService },
    });
    await executor.beginCodexKeyRotation();
    await executor.installCodexRuntimeKeys();
    expect(calls.begin).toBe(1);
    expect(calls.install).toHaveLength(1);
    expect(calls.install[0]!.keys).toEqual([
      {
        providerId: "acme",
        envName: codexNativeProviderKeyEnvName("acme"),
        value: "sk-live",
      },
      {
        providerId: "ghost",
        envName: codexNativeProviderKeyEnvName("ghost"),
        value: null,
      },
    ]);
  });

  it("rejects key rotation on an old remote but degrades initial install so connection stays open", async () => {
    const { environmentKey, credentialService } = setup();
    const keyService = createCodexNativeProviderKeyService({
      environmentKey,
      credentialService,
    });
    await keyService.prepareKeySource({
      providerId: "acme",
      mode: "runtime-env",
      apiKey: "sk-live",
    });
    await keyService.finishKeySource({ providerId: "acme", commit: true });

    const legacyTarget: IProviderProvisioningTargetService = {
      apply: async () => {
        throw new Error("unused");
      },
    };
    const executor = createRemoteProviderProvisioningExecutor({
      target: legacyTarget,
      codexKeys: { environmentKey, credentialService },
    });
    await expect(executor.beginCodexKeyRotation()).rejects.toThrow(/升级远端/);
    await expect(executor.installCodexRuntimeKeys()).resolves.toBeUndefined();

    // ProxyChannel.toService 始终暴露函数属性，通过 RPC Method not found 表达旧远端不支持。
    const proxyLegacyTarget: IProviderProvisioningTargetService = {
      apply: async () => {
        throw new Error("unused");
      },
      beginCodexProviderKeyRotation: async () => {
        throw new Error("Method not found: beginCodexProviderKeyRotation");
      },
      installCodexProviderKeys: async () => {
        throw new Error("Method not found: installCodexProviderKeys");
      },
    };
    const proxyExecutor = createRemoteProviderProvisioningExecutor({
      target: proxyLegacyTarget,
      codexKeys: { environmentKey, credentialService },
    });
    await expect(proxyExecutor.beginCodexKeyRotation()).rejects.toThrow(/升级远端/);
    await expect(proxyExecutor.installCodexRuntimeKeys()).resolves.toBeUndefined();
  });

  it("allows first connect with an empty registry on an old remote", async () => {
    const { environmentKey, credentialService } = setup();
    const calls: CodexNativeProviderKeyInstall[] = [];
    const legacyTarget: IProviderProvisioningTargetService = {
      apply: async () => {
        throw new Error("unused");
      },
      installCodexProviderKeys: async (input) => {
        calls.push(input);
        throw new Error("Method not found: installCodexProviderKeys");
      },
    };
    const executor = createRemoteProviderProvisioningExecutor({
      target: legacyTarget,
      codexKeys: { environmentKey, credentialService },
    });
    await expect(executor.installCodexRuntimeKeys()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("serializes concurrent installs in call order", async () => {
    const { environmentKey, credentialService } = setup();
    const keyService = createCodexNativeProviderKeyService({
      environmentKey,
      credentialService,
    });
    await keyService.prepareKeySource({
      providerId: "acme",
      mode: "runtime-env",
      apiKey: "sk-live",
    });
    await keyService.finishKeySource({ providerId: "acme", commit: true });
    const order: number[] = [];
    const { target } = fakeTarget({
      installCodexProviderKeys: async () => {
        order.push(1);
      },
    });
    const executor = createRemoteProviderProvisioningExecutor({
      target,
      codexKeys: { environmentKey, credentialService },
    });
    await Promise.all([executor.installCodexRuntimeKeys(), executor.installCodexRuntimeKeys()]);
    expect(order).toEqual([1, 1]);
  });

  it("rejects begin on environments without a local key source", async () => {
    const { target } = fakeTarget();
    const executor = createRemoteProviderProvisioningExecutor({ target });
    await expect(executor.beginCodexKeyRotation()).rejects.toThrow(/不支持/);
    // 无 codexKeys 的 Server remote：install 静默 no-op。
    await expect(executor.installCodexRuntimeKeys()).resolves.toBeUndefined();
  });
});
