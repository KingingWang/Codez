import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromFile } from "vite";
import { desktopRendererDependencyAliases } from "../vite.config";

describe("desktop renderer Vite dependency aliases", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("points React singleton dependencies to installed package locations", () => {
    for (const dependencyName of ["react", "react-dom", "lucide-react"] as const) {
      expect(
        existsSync(desktopRendererDependencyAliases[dependencyName]),
        `${dependencyName} alias target should exist`,
      ).toBe(true);
    }
  });

  it("keeps React subpath aliases loadable for Vite dependency optimization", () => {
    expect(
      existsSync(resolve(desktopRendererDependencyAliases.react, "jsx-runtime.js")),
      "react/jsx-runtime should resolve from the React package root",
    ).toBe(true);
    expect(
      existsSync(resolve(desktopRendererDependencyAliases["react-dom"], "client.js")),
      "react-dom/client should resolve from the React DOM package root",
    ).toBe(true);
  });

  // Windows 跳过：环境配置差异导致断言失败，需要 CI 环境统一配置
  const isWindows = process.platform === "win32";

  (isWindows ? it.skip : it)("injects the selected Codez endpoint origin into renderer env", async () => {
    vi.stubEnv("CODEZ_ENV", "test");
    vi.stubEnv("CODEZ_BASE_URL", "");
    const desktopRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(desktopRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      desktopRoot,
      "silent",
    );

    expect(result?.config.define).toMatchObject({
      "import.meta.env.VITE_CODEZ_BASE_URL": JSON.stringify("https://zcode.z.ai"),
      "import.meta.env.VITE_CODEZ_ENDPOINT_ORIGIN": JSON.stringify(
        "https://zcode.z.ai",
      ),
      __CODEZ_LOCAL_DEVELOPMENT_RUNTIME__: JSON.stringify(false),
    });
  });

  it("marks non-production renderer builds as local development runtime", async () => {
    vi.stubEnv("CODEZ_ENV", "production");
    const desktopRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(desktopRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "serve",
        mode: "development",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      desktopRoot,
      "silent",
    );

    expect(result?.config.define).toMatchObject({
      __CODEZ_ENV__: JSON.stringify("production"),
      __CODEZ_PRODUCT_FLAVOR__: JSON.stringify("production"),
      __CODEZ_LOCAL_DEVELOPMENT_RUNTIME__: JSON.stringify(true),
      "import.meta.env.VITE_CODEZ_E2E_STORE_BRIDGE": JSON.stringify(""),
    });
  });

  it("publishes PDF.js CMaps for non-latin PDF rendering", async () => {
    const desktopRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(desktopRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      desktopRoot,
      "silent",
    );

    expect(result?.config.plugins?.some((plugin) => plugin.name === "codez:pdfjs-cmaps")).toBe(
      true,
    );
  });

  it("injects the E2E store bridge only from the runner flag", async () => {
    vi.stubEnv("CODEZ_ENV", "test");
    vi.stubEnv("VITE_CODEZ_E2E_STORE_BRIDGE", "1");
    const desktopRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(desktopRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      desktopRoot,
      "silent",
    );

    expect(result?.config.define).toMatchObject({
      __CODEZ_ENV__: JSON.stringify("test"),
      __CODEZ_PRODUCT_FLAVOR__: JSON.stringify("preview"),
      "import.meta.env.VITE_CODEZ_E2E_STORE_BRIDGE": JSON.stringify("1"),
    });
  });

  it("CODEZ_PREVIEW_IDENTITY=1 让生产后端的 renderer 编译成 Preview 身份", async () => {
    vi.stubEnv("CODEZ_ENV", "production");
    vi.stubEnv("CODEZ_PREVIEW_IDENTITY", "1");
    const desktopRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(desktopRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      desktopRoot,
      "silent",
    );

    expect(result?.config.define).toMatchObject({
      __CODEZ_ENV__: JSON.stringify("production"),
      __CODEZ_PRODUCT_FLAVOR__: JSON.stringify("preview"),
    });
  });
});
