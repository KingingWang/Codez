import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderConfigMap, createAccountProviderConfigSnapshot } from "@codez/provider";
import {
  CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  CODEZ_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@codez/provider-node";
import { codezProtocolMethods } from "@codez/shared";
import {
  startProcessProviderRegistryRuntime,
  parseProcessAccountProviderConfigSnapshot,
} from "../src/app/process-provider-registry-runtime.js";
import { CodezProtocolAgentServer } from "../src/codez-protocol/server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startRuntime() {
  const directory = await mkdtemp(join(tmpdir(), "account-delivery-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const started = await startProcessProviderRegistryRuntime({
    [CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: fileURLToPath(
      new URL("../../../../../config/provider/codez-builtin.json", import.meta.url),
    ),
    [CODEZ_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(directory, "personal.json"),
  });
  cleanups.unshift(async () => started.dispose());
  return started;
}

describe("托管 Worker 账号交付", () => {
  it("Account B 先到时接收 B、仍使用 A；配套配置到后才整体应用 B", async () => {
    const started = await startRuntime();
    const registry = started.runtime.registryService;
    const previous = registry.getSnapshot();
    const next = createAccountProviderConfigSnapshot("builtin-B", ProviderConfigMap.empty(), {});
    const server = new CodezProtocolAgentServer({
      createCodezApp() {
        throw new Error("账号交付不得创建会话");
      },
      syncAccountProviderConfig: started.syncAccountProviderConfig,
    });
    expect(
      await server.handleMessage({
        id: 1,
        method: codezProtocolMethods.providerUpdateAccountConfig,
        params: {
          ...next,
          providers: Object.fromEntries(
            [...next.providers.entries()].map(([id, config]) => [id, config.toJSON()]),
          ),
        },
      }),
    ).toMatchObject({
      result: { receivedRevision: next.revision, providerCount: 0, status: "received" },
    });
    expect((await started.accountSource.read()).revision).toBe(next.revision);
    expect(registry.getSnapshot()).toBe(previous);

    const config = await started.runtime.configService.read();
    vi.spyOn(started.runtime.configService, "read").mockResolvedValue({
      ...config,
      revision: "config-B",
      codezBuiltinRevision: "builtin-B",
    });
    await registry.refresh("配套配置到达");
    expect(registry.getSnapshot()?.account.revision).toBe(next.revision);
    expect(registry.getSnapshot()?.config.codezBuiltinRevision).toBe("builtin-B");
  });

  it("刷新失败后同一份快照重交仍刷新，不能因 Source 已收过而跳过", async () => {
    const started = await startRuntime();
    const next = createAccountProviderConfigSnapshot(
      started.snapshot.config.codezBuiltinRevision,
      ProviderConfigMap.empty(),
      {},
    );
    const refresh = vi
      .spyOn(started.runtime.registryService, "refresh")
      .mockRejectedValueOnce(new Error("refresh failed"));
    await expect(started.syncAccountProviderConfig(next)).rejects.toThrow("refresh failed");
    await expect(started.syncAccountProviderConfig(next)).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(started.runtime.registryService.getSnapshot()?.account.revision).toBe(next.revision);
  });

  it("普通账号有权益却缺 current 时拒绝交付，不能宽松放行", () => {
    expect(() =>
      parseProcessAccountProviderConfigSnapshot({
        revision: "incomplete",
        basedOnCodezBuiltinRevision: "builtin-A",
        providers: {
          "account:bigmodel-individual-coding-plan": {
            access: { type: "zhipu-account", entitled: true },
          },
        },
        states: {},
      }),
    ).toThrow("current");
  });

  it.each([
    { providerId: "account:bigmodel-individual-coding-plan", entitled: false },
    { providerId: "account:bigmodel-offpeak-idle-plan", entitled: true },
  ])("初始 fail-closed 和闲时不被强加 current：$providerId", ({ providerId, entitled }) => {
    expect(() =>
      parseProcessAccountProviderConfigSnapshot({
        revision: "allowed",
        basedOnCodezBuiltinRevision: "builtin-A",
        states: {},
        providers: { [providerId]: { access: { type: "zhipu-account", entitled } } },
      }),
    ).not.toThrow();
  });
});
