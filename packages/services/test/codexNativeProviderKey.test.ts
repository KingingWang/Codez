import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_NATIVE_PROVIDER_LOCAL_ENVIRONMENT_KEY,
  codexNativeProviderKeyCredentialKey,
  codexNativeProviderKeyEnvName,
  codexNativeProviderSpawnEnvFromInstalled,
  createCodexNativeProviderKeyService,
  filterCodexNativeKeysByConfigFile,
  resolveCodexNativeProviderSpawnEnv,
} from "../src/model-provider/codexNativeProviderKey.js";
import { setDataBaseDir } from "../src/paths.js";
import type { ICredentialService } from "../src/credential/credential.js";
import { createCredentialService } from "../src/credential/credentialService.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-native-key-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  setDataBaseDir(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createIsolatedCredentialService(): ICredentialService {
  setDataBaseDir(makeTempDir());
  return createCredentialService();
}

describe("codexNativeProviderKey env/credential naming", () => {
  it("derives stable managed env names with the app prefix", () => {
    const name = codexNativeProviderKeyEnvName("my-provider");
    expect(name).toMatch(/^CODEZ_CODEX_API_KEY_[A-F0-9]{16}$/);
    expect(codexNativeProviderKeyEnvName("my-provider")).toBe(name);
    expect(codexNativeProviderKeyEnvName("other")).not.toBe(name);
  });

  it("isolates credential keys by environment identity", () => {
    const local = codexNativeProviderKeyCredentialKey(
      CODEX_NATIVE_PROVIDER_LOCAL_ENVIRONMENT_KEY,
      "p1",
    );
    const remote = codexNativeProviderKeyCredentialKey(
      "ssh:user@host:22",
      "p1",
    );
    expect(local).not.toBe(remote);
    expect(local).toContain("codex-native-provider-key:");
  });
});

describe("createCodexNativeProviderKeyService", () => {
  it("saves runtime-env key locally and reports configured state", async () => {
    const credentials = createIsolatedCredentialService();
    const disposeLocalRuntimes = vi.fn(async () => {});
    const service = createCodexNativeProviderKeyService({
      environmentKey: "local",
      credentialService: credentials,
      disposeLocalRuntimes,
    });

    const prepared = await service.prepareKeySource({
      providerId: "acme",
      mode: "runtime-env",
      apiKey: "sk-test",
    });
    expect(prepared.envName).toBe(codexNativeProviderKeyEnvName("acme"));
    expect((await service.getKeyState({ providerId: "acme" })).configured).toBe(
      true,
    );

    await service.finishKeySource({ providerId: "acme", commit: true });
    expect(disposeLocalRuntimes).toHaveBeenCalledTimes(1);
    // 持久化跨实例可见（注册表 + Credential Store 均在磁盘）。
    const reread = createCodexNativeProviderKeyService({
      environmentKey: "local",
      credentialService: credentials,
    });
    expect((await reread.getKeyState({ providerId: "acme" })).configured).toBe(
      true,
    );
  });

  it("rejects runtime-env prepare without any key before starting rotation", async () => {
    const credentials = createIsolatedCredentialService();
    const beginRotation = vi.fn(async () => {});
    const service = createCodexNativeProviderKeyService({
      environmentKey: "ssh:x",
      credentialService: credentials,
      beginRotation,
      installKeys: async () => {},
    });
    await expect(
      service.prepareKeySource({ providerId: "acme", mode: "runtime-env" }),
    ).rejects.toThrow(/API Key/);
    expect(beginRotation).not.toHaveBeenCalled();
  });

  it("rolls back credential and registry on finish(commit=false)", async () => {
    const credentials = createIsolatedCredentialService();
    const service = createCodexNativeProviderKeyService({
      environmentKey: "local",
      credentialService: credentials,
    });
    await service.prepareKeySource({
      providerId: "acme",
      mode: "runtime-env",
      apiKey: "old",
    });
    await service.finishKeySource({ providerId: "acme", commit: true });

    await service.prepareKeySource({
      providerId: "acme",
      mode: "runtime-env",
      apiKey: "new",
    });
    await service.finishKeySource({ providerId: "acme", commit: false });
    const spawn = await resolveCodexNativeProviderSpawnEnv({
      credentialService: credentials,
      environmentKey: "local",
    });
    expect(spawn.env[codexNativeProviderKeyEnvName("acme")]).toBe("old");
    expect(spawn.blockedProviderIds).toEqual([]);
  });

  it("defers delete-mode writes until commit", async () => {
    const credentials = createIsolatedCredentialService();
    const service = createCodexNativeProviderKeyService({
      environmentKey: "local",
      credentialService: credentials,
    });
    await service.prepareKeySource({
      providerId: "acme",
      mode: "runtime-env",
      apiKey: "k",
    });
    await service.finishKeySource({ providerId: "acme", commit: true });

    // 回滚路径：凭据与注册表保持。
    await service.prepareKeySource({ providerId: "acme", mode: "delete" });
    await service.finishKeySource({ providerId: "acme", commit: false });
    expect((await service.getKeyState({ providerId: "acme" })).configured).toBe(
      true,
    );

    await service.prepareKeySource({ providerId: "acme", mode: "delete" });
    await service.finishKeySource({ providerId: "acme", commit: true });
    const state = await service.getKeyState({ providerId: "acme" });
    expect(state.configured).toBe(false);
    const spawn = await resolveCodexNativeProviderSpawnEnv({
      credentialService: credentials,
      environmentKey: "local",
    });
    expect(Object.keys(spawn.env)).toHaveLength(0);
  });

  it("blocks spawn env for managed references without credentials", async () => {
    const credentials = createIsolatedCredentialService();
    const service = createCodexNativeProviderKeyService({
      environmentKey: "local",
      credentialService: credentials,
    });
    await service.prepareKeySource({
      providerId: "acme",
      mode: "runtime-env",
      apiKey: "k",
    });
    await service.finishKeySource({ providerId: "acme", commit: true });
    // 删除凭据模拟「配置在、Key 不在」；注册表条目仍在。
    await credentials.delete(
      codexNativeProviderKeyCredentialKey("local", "acme"),
    );
    const spawn = await resolveCodexNativeProviderSpawnEnv({
      credentialService: credentials,
      environmentKey: "local",
    });
    const envName = codexNativeProviderKeyEnvName("acme");
    expect(spawn.env[envName]).toBeUndefined();
    expect(envName in spawn.env).toBe(true);
    expect(spawn.blockedProviderIds).toEqual(["acme"]);
  });

  it("finishKeySource 日志区分 commit 与 rollback，且不含 Key 材料", async () => {
    // Bugfix 诊断盲点：commit 与 rollback 共用同一条成功路径，RPC 层只打印
    // finishKeySource OK，曾出现三次保存全绿但远端 config.toml 一步未改。
    const credentials = createIsolatedCredentialService();
    const logged: unknown[] = [];
    const service = createCodexNativeProviderKeyService({
      environmentKey: 'ssh:["ssh:v1","host",22,"user","key","~/.ssh/id_rsa"]',
      credentialService: credentials,
      beginRotation: async () => {},
      installKeys: async () => {},
    });

    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(...args);
    };
    try {
      await service.prepareKeySource({
        providerId: "acme",
        mode: "runtime-env",
        apiKey: "sk-secret-must-not-appear",
      });
      await service.finishKeySource({ providerId: "acme", commit: true });
      await service.prepareKeySource({
        providerId: "acme",
        mode: "runtime-env",
        apiKey: "sk-secret-must-not-appear",
      });
      await service.finishKeySource({ providerId: "acme", commit: false });
    } finally {
      console.log = originalLog;
    }

    const finish = logged.filter(
      (entry) => entry === "codex provider key finish",
    );
    expect(finish).toHaveLength(2);
    const payloads = logged.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" &&
        entry !== null &&
        "commit" in (entry as Record<string, unknown>),
    );
    expect(payloads.map((entry) => entry.commit)).toEqual([true, false]);
    for (const entry of payloads) {
      expect(entry.providerId).toBe("acme");
      expect(entry.mode).toBe("runtime-env");
      // Environment 身份只落哈希，不落 SSH 主机地址。
      expect(String(entry.scope)).toMatch(/^[A-F0-9]{16}$/);
      expect(String(entry.scope)).not.toContain("host");
      expect(entry.barrierBegan).toBe(true);
    }
    // 日志不得包含 Key 材料。
    expect(logged.map((entry) => String(entry)).join("|")).not.toContain(
      "sk-secret-must-not-appear",
    );
  });

  it("keeps begin→install ordering through rotation callbacks", async () => {
    const credentials = createIsolatedCredentialService();
    const calls: string[] = [];
    const service = createCodexNativeProviderKeyService({
      environmentKey: "ssh:x",
      credentialService: credentials,
      beginRotation: async () => {
        calls.push("begin");
      },
      installKeys: async () => {
        calls.push("install");
      },
    });
    await service.prepareKeySource({
      providerId: "acme",
      mode: "runtime-env",
      apiKey: "k",
    });
    await service.finishKeySource({ providerId: "acme", commit: true });
    expect(calls).toEqual(["begin", "install"]);
  });

  it("releases the rotation barrier when prepare fails after begin", async () => {
    const credentials = createIsolatedCredentialService();
    const calls: string[] = [];
    // begin 成功后让凭据写入失败：验证屏障解除与旧凭据不被破坏。
    const failingCredentials: ICredentialService = {
      load: (key) => credentials.load(key),
      delete: (key) => credentials.delete(key),
      save: async (key, value) => {
        if (value === "new") throw new Error("disk full");
        return credentials.save(key, value);
      },
    };
    const service = createCodexNativeProviderKeyService({
      environmentKey: "ssh:x",
      credentialService: failingCredentials,
      beginRotation: async () => {
        calls.push("begin");
      },
      installKeys: async () => {
        calls.push("install");
      },
    });
    await expect(
      service.prepareKeySource({
        providerId: "acme",
        mode: "runtime-env",
        apiKey: "new",
      }),
    ).rejects.toThrow();
    expect(calls).toEqual(["begin", "install"]);
    expect(
      await credentials.load(
        codexNativeProviderKeyCredentialKey("ssh:x", "acme"),
      ),
    ).toBeNull();
  });
});

describe("codexNativeProviderSpawnEnvFromInstalled", () => {
  it("blocks every managed provider during rotation", () => {
    const installed = new Map([
      [
        "CODEZ_CODEX_API_KEY_AAAA0000BBBB1111",
        { providerId: "a", value: "k1" },
      ],
      [
        "CODEZ_CODEX_API_KEY_CCCC2222DDDD3333",
        { providerId: "b", value: null },
      ],
    ]);
    const rotating = codexNativeProviderSpawnEnvFromInstalled(installed, true);
    expect(rotating.blockedProviderIds.sort()).toEqual(["a", "b"]);
    const settled = codexNativeProviderSpawnEnvFromInstalled(installed, false);
    expect(settled.blockedProviderIds).toEqual(["b"]);
    expect(settled.env.CODEZ_CODEX_API_KEY_AAAA0000BBBB1111).toBe("k1");
    expect("CODEZ_CODEX_API_KEY_CCCC2222DDDD3333" in settled.env).toBe(true);
    expect(settled.env.CODEZ_CODEX_API_KEY_CCCC2222DDDD3333).toBeUndefined();
  });
});

describe("filterCodexNativeKeysByConfigFile", () => {
  it("keeps only entries still referenced by env_key in the target config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-native-key-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.toml");
    const envName = codexNativeProviderKeyEnvName("acme");
    await writeFile(
      configPath,
      `[model_providers.acme]\nname = "acme"\nenv_key = "${envName}"\n\n[model_providers.other]\nname = "other"\nenv_key = "EXTERNAL_KEY"\n`,
    );
    const filtered = await filterCodexNativeKeysByConfigFile(
      [
        { providerId: "acme", envName, value: "k" },
        {
          providerId: "other",
          envName: codexNativeProviderKeyEnvName("other"),
          value: "k2",
        },
        {
          providerId: "gone",
          envName: codexNativeProviderKeyEnvName("gone"),
          value: "k3",
        },
      ],
      configPath,
    );
    expect(filtered.map((entry) => entry.providerId)).toEqual(["acme"]);
  });

  it("treats a missing config file as no references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-native-key-config-"));
    tempDirs.push(dir);
    await expect(
      filterCodexNativeKeysByConfigFile(
        [
          {
            providerId: "acme",
            envName: codexNativeProviderKeyEnvName("acme"),
            value: "k",
          },
        ],
        join(dir, "config.toml"),
      ),
    ).resolves.toEqual([]);
  });
});
