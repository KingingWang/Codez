import { describe, expect, it } from "vitest";
import {
  buildCliCodezSourceHeaders,
  createRuntimeAiSdkModelExecutionConfig,
} from "../src/model-config.js";
import { createModelAdapter, type CreateModelAdapterOptions } from "../src/model-factory.js";

describe("createModelAdapter", () => {
  it("缺少执行基础设施配置时拒绝创建 Adapter", () => {
    expect(() => createModelAdapter({ env: {} } as CreateModelAdapterOptions)).toThrow(
      "requires executionConfig",
    );
  });
});

describe("createRuntimeAiSdkModelExecutionConfig", () => {
  it("装配来源 Header、网络和路由基础设施", () => {
    const endpointRoutingPort = {
      async resolve(url: string) {
        return { routed: false, url };
      },
    };
    const config = createRuntimeAiSdkModelExecutionConfig(
      { CODEZ_APP_VERSION: "3.9.0", CODEZ_ENV: "test" },
      {
        endpointRoutingPort,
        network: {
          caCertFile: "/tmp/test-ca.pem",
          httpProxy: "http://proxy.example.com",
          noProxy: "localhost",
        },
        sourceTitle: "electron",
      },
    );
    expect(config).toMatchObject({
      defaultHeaders: {
        "User-Agent": "Codez/3.9.0",
        "X-Codez-App-Version": "3.9.0",
        "X-Title": "Z Code@electron",
      },
      endpointRoutingPort,
      network: {
        caCertFile: "/tmp/test-ca.pem",
        httpProxy: "http://proxy.example.com",
        noProxy: "localhost",
      },
    });
  });

  it("过滤空网络配置", () => {
    expect(createRuntimeAiSdkModelExecutionConfig({}, { network: {} })).not.toHaveProperty(
      "network",
    );
  });
});

describe("buildCliCodezSourceHeaders", () => {
  it("生成运行时来源 Header，不根据模型或 Provider 推断", () => {
    expect(
      buildCliCodezSourceHeaders(
        { CODEZ_APP_VERSION: "3.9.0", CODEZ_ENV: "production" },
        { sourceTitle: "cli" },
      ),
    ).toMatchObject({
      "User-Agent": "Codez/3.9.0",
      "X-Title": "Z Code@cli",
      "X-Codez-App-Version": "3.9.0",
    });
  });

  it("X-Client-Language 优先使用 Desktop 下发的界面语言", () => {
    expect(
      buildCliCodezSourceHeaders({ CODEZ_CLIENT_LANGUAGE: " ja-JP " }, { sourceTitle: "electron" }),
    ).toMatchObject({ "X-Client-Language": "ja-JP" });
  });

  it("界面语言为空或含非打印字符时回落进程 Intl", () => {
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    for (const value of ["", "  ", "ko\u0001KR"]) {
      expect(
        buildCliCodezSourceHeaders({ CODEZ_CLIENT_LANGUAGE: value }, { sourceTitle: "cli" }),
      ).toMatchObject({ "X-Client-Language": intlLocale });
    }
  });
});
