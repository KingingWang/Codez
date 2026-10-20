import { describe, expect, it, vi } from "vitest";
import { saveProviderApiKeySource } from "../src/model-provider/providerKeySourceService.js";

function fixture() {
  const secrets = new Map<string, string>();
  const savePersonalProviderOverlay = vi.fn(async (_providerId: string, config: unknown) => ({
    providers: [{ personalConfig: config }],
  }));
  const providerSettings = {
    getView: vi.fn(async () => ({
      providers: [
        {
          providerId: "custom",
          effectiveConfig: {
            access: { type: "api-key", apiKey: "old-inline-key" },
          },
          personalConfig: {
            access: { type: "api-key", apiKey: "old-inline-key" },
          },
        },
      ],
    })),
    savePersonalProviderOverlay,
  } as never;
  const credentials = {
    load: vi.fn(async (key: string) => secrets.get(key) ?? null),
    save: vi.fn(async (key: string, value: string) => {
      secrets.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      secrets.delete(key);
    }),
  };
  return { providerSettings, credentials, secrets, savePersonalProviderOverlay };
}

describe("Provider Key source owner", () => {
  it("moves a local inline Key into the credential store before committing an env reference", async () => {
    const f = fixture();
    await saveProviderApiKeySource(f, { providerId: "custom", mode: "runtime-env" });
    expect(f.secrets.get("provider-runtime-key:custom")).toBe("old-inline-key");
    const saved = f.savePersonalProviderOverlay.mock.calls[0]?.[1] as {
      access: { apiKey: string | null; apiKeyEnv: string };
    };
    expect(saved.access.apiKey).toBeNull();
    expect(saved.access.apiKeyEnv).toMatch(/^CODEZ_MODEL_API_KEY_[A-F0-9]{16}$/);
    expect(JSON.stringify(saved)).not.toContain("old-inline-key");
  });

  it("restores the previous local secret if the config commit fails", async () => {
    const f = fixture();
    f.secrets.set("provider-runtime-key:custom", "previous");
    f.savePersonalProviderOverlay.mockRejectedValueOnce(new Error("config failed"));
    await expect(
      saveProviderApiKeySource(f, {
        providerId: "custom",
        mode: "runtime-env",
        apiKey: "replacement",
      }),
    ).rejects.toThrow("config failed");
    expect(f.secrets.get("provider-runtime-key:custom")).toBe("previous");
  });
});
