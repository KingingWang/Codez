import { afterEach, describe, expect, it, vi } from "vitest";

async function importFreshEnvModule() {
  vi.resetModules();
  return await import("../src/env.js");
}

describe("shared runtime env", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("构建期可选能力未注入时关闭，事件上报端点取测试注入值", async () => {
    const env = await importFreshEnvModule();

    // 单测不注入 ARMS 与自动更新；事件上报端点由 vitest.config.ts 固定注入。
    expect(env.CODEZ_ARMS_RUM_ENDPOINT).toBe("");
    expect(env.CODEZ_AUTO_UPDATE_ENABLED).toBe(false);
    expect(env.CODEZ_TELEMETRY_REPORT_ENDPOINT).toBe("https://zcode.z.ai/api/v1/event/report");
  });

  it("未注入 CODEZ_ENV 时默认 test 并映射为 local", async () => {
    vi.stubGlobal("__CODEZ_ENV__", undefined);

    const env = await importFreshEnvModule();

    expect(env.CODEZ_ENV).toBe("test");
    expect(env.normalizeCodezEnv("development")).toBe("test");
    expect(env.mapCodezEnvToArmsRumEnv("production")).toBe("local");
  });

  it("未注入身份 define 时 flavor 跟随 CODEZ_ENV", async () => {
    vi.stubGlobal("__CODEZ_ENV__", "production");
    vi.stubGlobal("__CODEZ_PRODUCT_FLAVOR__", undefined);

    const env = await importFreshEnvModule();

    expect(env.CODEZ_PRODUCT_FLAVOR).toBe("production");
    expect(env.normalizeCodezProductFlavor(undefined, "test")).toBe("preview");
    expect(env.normalizeCodezProductFlavor("bogus", "production")).toBe("production");
  });

  it("显式注入 preview 身份时生产后端构建仍是 Preview", async () => {
    vi.stubGlobal("__CODEZ_ENV__", "production");
    vi.stubGlobal("__CODEZ_PRODUCT_FLAVOR__", "preview");

    const env = await importFreshEnvModule();

    expect(env.CODEZ_ENV).toBe("production");
    expect(env.CODEZ_PRODUCT_FLAVOR).toBe("preview");
  });

  it("mapCodezEnvToArmsRumEnv 将非本地 production 映射为 prod", async () => {
    vi.stubGlobal("__CODEZ_ENV__", "production");

    const env = await importFreshEnvModule();

    expect(env.mapCodezEnvToArmsRumEnv("production")).toBe("prod");
  });

  it("mapCodezEnvToArmsRumEnv 在本地开发态忽略 production 产品环境并映射为 local", async () => {
    vi.stubGlobal("__CODEZ_ENV__", "production");

    const env = await importFreshEnvModule();

    expect(env.mapCodezEnvToArmsRumEnv("development")).toBe("local");
  });
});
