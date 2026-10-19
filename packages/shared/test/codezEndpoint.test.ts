import { describe, expect, it } from "vitest";
import {
  DEFAULT_BIGMODEL_API_ORIGIN,
  DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL,
  DEFAULT_ZAI_BUSINESS_BASE_URL,
  DEFAULT_ZAI_OAUTH_CLIENT_ID,
  DEFAULT_ZAI_OAUTH_ORIGIN,
  DEFAULT_CODEZ_ENDPOINT_ORIGIN,
  TEST_BIGMODEL_API_ORIGIN,
  TEST_ZAI_BUSINESS_BASE_URL,
  TEST_ZAI_OAUTH_CLIENT_ID,
  TEST_ZAI_OAUTH_ORIGIN,
  TEST_CODEZ_ENDPOINT_ORIGIN,
  buildBigModelCodingPlanPersonalManageUrl,
  buildBigModelCodingPlanTeamManageUrl,
  buildBigModelApiUrl,
  buildRuntimeCodezApiUrl,
  buildRuntimeZaiBusinessUrl,
  buildRuntimeZaiOAuthUrl,
  buildRuntimeCodezEndpointUrls,
  buildCodezEndpointUrls,
  normalizeCodezEndpointOrigin,
  resolveBigModelApiOrigin,
  resolveRuntimeProductEndpointConfig,
  resolveWebRemoteControlRelayWsUrl,
  resolveZaiBusinessBaseUrl,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
  resolveCodezEndpointOrigin,
} from "../src/codezEndpoint.js";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

describe("codezEndpoint", () => {
  it("defaults to the scoped origin in every env without env base url", () => {
    expect(resolveCodezEndpointOrigin({ env: "test" })).toBe(TEST_CODEZ_ENDPOINT_ORIGIN);
    expect(resolveCodezEndpointOrigin({ env: "production" })).toBe(DEFAULT_CODEZ_ENDPOINT_ORIGIN);
  });

  it("keeps the non-production settings override above env base url", () => {
    expect(
      resolveCodezEndpointOrigin({
        env: "test",
        envBaseOrigin: "https://zcode.z.ai",
        overrideOrigin: "http://localhost:3030/api/v1",
      }),
    ).toBe("http://localhost:3030");
  });

  it("uses a non-production override after normalizing to origin", () => {
    expect(
      resolveCodezEndpointOrigin({
        env: "test",
        overrideOrigin: "https://zcode.z.ai/api/v1/ignored?x=1",
      }),
    ).toBe(TEST_CODEZ_ENDPOINT_ORIGIN);
  });

  it("ignores overrides in production", () => {
    expect(
      resolveCodezEndpointOrigin({
        env: "production",
        envBaseOrigin: "https://zcode.z.ai",
        overrideOrigin: "https://zcode.z.ai",
      }),
    ).toBe(DEFAULT_CODEZ_ENDPOINT_ORIGIN);
  });

  it("derives http and websocket urls from the same origin", () => {
    expect(buildCodezEndpointUrls("http://localhost:3030")).toEqual({
      origin: "http://localhost:3030",
      apiBaseUrl: "http://localhost:3030/api/v1",
      remoteUrl: "http://localhost:3030/remote/v3",
      webRemoteCallbackUrl: "http://localhost:3030/remote/v4",
      webShareCallbackUrl: "http://localhost:3030/cn/share/callback",
      relayWsUrl: "ws://localhost:3030/api/v1/remote/ws2",
      codezPlanOpenAiBaseUrl: "http://localhost:3030/api/v1/zcode-plan",
      codezPlanAnthropicBaseUrl: "http://localhost:3030/api/v1/zcode-plan/anthropic",
      codezPlanBillingCurrentUrl: "http://localhost:3030/api/v1/zcode-plan/billing/current",
      codezPlanBillingBalanceUrl: "http://localhost:3030/api/v1/zcode-plan/billing/balance",
    });
  });

  it("uses remote v3 for app versions below 3.4.0", () => {
    expect(buildCodezEndpointUrls("https://zcode.z.ai", { appVersion: "3.3.9" }).remoteUrl).toBe(
      "https://zcode.z.ai/remote/v3",
    );
  });

  it("uses remote v4 for app versions at or above 3.4.0", () => {
    expect(buildCodezEndpointUrls("https://zcode.z.ai", { appVersion: "3.4.0" }).remoteUrl).toBe(
      "https://zcode.z.ai/remote/v4",
    );
    expect(buildCodezEndpointUrls("https://zcode.z.ai", { appVersion: "3.4.1" }).remoteUrl).toBe(
      "https://zcode.z.ai/remote/v4",
    );
    expect(
      buildCodezEndpointUrls("https://zcode.z.ai", { appVersion: "3.5.0-beta.1" }).remoteUrl,
    ).toBe("https://zcode.z.ai/remote/v4");
  });

  it("keeps prerelease and invalid app versions on remote v3", () => {
    expect(
      buildCodezEndpointUrls("https://zcode.z.ai", { appVersion: "3.4.0-beta.1" }).remoteUrl,
    ).toBe("https://zcode.z.ai/remote/v3");
    expect(buildCodezEndpointUrls("https://zcode.z.ai", { appVersion: "dev" }).remoteUrl).toBe(
      "https://zcode.z.ai/remote/v3",
    );
    expect(buildCodezEndpointUrls("https://zcode.z.ai", { appVersion: "03.4.0" }).remoteUrl).toBe(
      "https://zcode.z.ai/remote/v3",
    );
    expect(
      buildCodezEndpointUrls("https://zcode.z.ai", { appVersion: "3.4.1-alpha..1" }).remoteUrl,
    ).toBe("https://zcode.z.ai/remote/v3");
    expect(buildCodezEndpointUrls("https://zcode.z.ai", { appVersion: "3.4.1-01" }).remoteUrl).toBe(
      "https://zcode.z.ai/remote/v3",
    );
  });

  it("derives runtime codez-plan urls from CODEZ_ENV", () => {
    expect(buildRuntimeCodezEndpointUrls({ CODEZ_ENV: "test" }).codezPlanOpenAiBaseUrl).toBe(
      "https://zcode.z.ai/api/v1/zcode-plan",
    );
    expect(buildRuntimeCodezEndpointUrls({ CODEZ_ENV: "production" }).codezPlanOpenAiBaseUrl).toBe(
      "https://zcode.z.ai/api/v1/zcode-plan",
    );
    expect(buildRuntimeCodezEndpointUrls({}).codezPlanOpenAiBaseUrl).toBe(
      "https://zcode.z.ai/api/v1/zcode-plan",
    );
    expect(
      buildRuntimeCodezEndpointUrls({
        CODEZ_ENV: "test",
        CODEZ_BASE_URL: "https://zcode.z.ai/ignored/path",
      }).codezPlanAnthropicBaseUrl,
    ).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic");
  });

  it("derives V2 relay from each endpoint origin", () => {
    expect(
      resolveWebRemoteControlRelayWsUrl({
        endpointOrigin: TEST_CODEZ_ENDPOINT_ORIGIN,
      }),
    ).toBe("wss://zcode.z.ai/api/v1/remote/ws2");
    expect(
      resolveWebRemoteControlRelayWsUrl({
        endpointOrigin: DEFAULT_CODEZ_ENDPOINT_ORIGIN,
      }),
    ).toBe(DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL);
    expect(
      resolveWebRemoteControlRelayWsUrl({
        endpointOrigin: "http://localhost:3030",
      }),
    ).toBe("ws://localhost:3030/api/v1/remote/ws2");
  });

  it("allows an explicit web remote control relay url override", () => {
    expect(
      resolveWebRemoteControlRelayWsUrl({
        endpointOrigin: TEST_CODEZ_ENDPOINT_ORIGIN,
        overrideUrl: " ws://localhost:8787/api/v1/remote/ws2 ",
      }),
    ).toBe("ws://localhost:8787/api/v1/remote/ws2");
  });

  it("derives BigModel API origin from CODEZ_ENV", () => {
    expect(resolveBigModelApiOrigin({ CODEZ_ENV: "production" })).toBe("https://bigmodel.cn");
    expect(resolveBigModelApiOrigin({ CODEZ_ENV: "test" })).toBe("https://bigmodel.cn");
    expect(buildBigModelApiUrl({ CODEZ_ENV: "test" }, "/api/biz/subscription/list")).toBe(
      "https://bigmodel.cn/api/biz/subscription/list",
    );
  });

  it("derives BigModel Coding Plan manage urls from CODEZ_ENV", () => {
    expect(buildBigModelCodingPlanPersonalManageUrl({ CODEZ_ENV: "test" })).toBe(
      "https://bigmodel.cn/coding-plan/personal/overview",
    );
    expect(buildBigModelCodingPlanPersonalManageUrl({ CODEZ_ENV: "production" })).toBe(
      "https://bigmodel.cn/coding-plan/personal/overview",
    );
    expect(buildBigModelCodingPlanTeamManageUrl({ CODEZ_ENV: "test" })).toBe(
      "https://bigmodel.cn/coding-plan/team/plans",
    );
    expect(buildBigModelCodingPlanTeamManageUrl({ CODEZ_ENV: "production" })).toBe(
      "https://bigmodel.cn/coding-plan/team/plans",
    );
  });

  it("resolves all product endpoints for the test product environment", () => {
    expect(resolveRuntimeProductEndpointConfig({ CODEZ_ENV: "test" })).toMatchObject({
      codezEnv: "test",
      codezEndpointOrigin: TEST_CODEZ_ENDPOINT_ORIGIN,
      zaiOAuthOrigin: TEST_ZAI_OAUTH_ORIGIN,
      zaiBusinessBaseUrl: TEST_ZAI_BUSINESS_BASE_URL,
      zaiOAuthClientId: TEST_ZAI_OAUTH_CLIENT_ID,
      bigModelApiOrigin: TEST_BIGMODEL_API_ORIGIN,
    });
  });

  it("resolves all product endpoints for the production product environment", () => {
    expect(resolveRuntimeProductEndpointConfig({ CODEZ_ENV: "production" })).toMatchObject({
      codezEnv: "production",
      codezEndpointOrigin: DEFAULT_CODEZ_ENDPOINT_ORIGIN,
      zaiOAuthOrigin: DEFAULT_ZAI_OAUTH_ORIGIN,
      zaiBusinessBaseUrl: DEFAULT_ZAI_BUSINESS_BASE_URL,
      zaiOAuthClientId: DEFAULT_ZAI_OAUTH_CLIENT_ID,
      bigModelApiOrigin: DEFAULT_BIGMODEL_API_ORIGIN,
    });
  });

  it("builds product endpoint URLs from the selected environment", () => {
    expect(buildRuntimeCodezApiUrl({ CODEZ_ENV: "test" }, "/api/v1/oauth/token")).toBe(
      "https://zcode.z.ai/api/v1/oauth/token",
    );
    expect(buildRuntimeZaiOAuthUrl({ CODEZ_ENV: "test" }, "/api/oauth/authorize")).toBe(
      "https://chat.z.ai/api/oauth/authorize",
    );
    expect(buildRuntimeZaiBusinessUrl({ CODEZ_ENV: "test" }, "/api/auth/z/login")).toBe(
      "https://api.z.ai/api/auth/z/login",
    );
    expect(buildBigModelApiUrl({ CODEZ_ENV: "test" }, "/login")).toBe(
      "https://bigmodel.cn/login",
    );
  });

  it("keeps environment-scoped endpoint overrides centralized", () => {
    const env = {
      CODEZ_ENV: "test",
      CODEZ_TEST_BASE_URL: "https://test-codez.example.com/path",
      ZAI_TEST_OAUTH_ORIGIN: "https://test-oauth.example.com/oauth",
      ZAI_TEST_BUSINESS_BASE_URL: "https://test-business.example.com/api",
      ZAI_TEST_OAUTH_CLIENT_ID: "client_test_override",
      BIGMODEL_TEST_API_BASE_URL: "https://test-bigmodel.example.com/base",
    };

    expect(resolveRuntimeProductEndpointConfig(env)).toMatchObject({
      codezEndpointOrigin: "https://test-codez.example.com",
      zaiOAuthOrigin: "https://test-oauth.example.com",
      zaiBusinessBaseUrl: "https://test-business.example.com",
      zaiOAuthClientId: "client_test_override",
      bigModelApiOrigin: "https://test-bigmodel.example.com",
    });
  });

  it("keeps unscoped endpoint overrides above scoped endpoint overrides", () => {
    const env = {
      CODEZ_ENV: "test",
      ZAI_OAUTH_ORIGIN: "https://oauth-global.example.com",
      ZAI_TEST_OAUTH_ORIGIN: "https://oauth-test.example.com",
      ZAI_BUSINESS_BASE_URL: "https://business-global.example.com",
      ZAI_TEST_BUSINESS_BASE_URL: "https://business-test.example.com",
      ZAI_OAUTH_CLIENT_ID: "client_global",
      ZAI_TEST_OAUTH_CLIENT_ID: "client_test",
      BIGMODEL_API_BASE_URL: "https://bigmodel-global.example.com",
      BIGMODEL_TEST_API_BASE_URL: "https://bigmodel-test.example.com",
    };

    expect(resolveZaiOAuthOrigin(env)).toBe("https://oauth-global.example.com");
    expect(resolveZaiBusinessBaseUrl(env)).toBe("https://business-global.example.com");
    expect(resolveZaiOAuthClientId(env)).toBe("client_global");
    expect(resolveBigModelApiOrigin(env)).toBe("https://bigmodel-global.example.com");
  });

  it("ignores blank runtime endpoint overrides", () => {
    const env = {
      CODEZ_ENV: "test",
      CODEZ_BASE_URL: " ",
      CODEZ_TEST_BASE_URL: "\t",
      ZAI_OAUTH_ORIGIN: "",
      ZAI_TEST_OAUTH_ORIGIN: " ",
      ZAI_BUSINESS_BASE_URL: " ",
      ZAI_TEST_BUSINESS_BASE_URL: "",
      ZAI_OAUTH_CLIENT_ID: "",
      ZAI_TEST_OAUTH_CLIENT_ID: " ",
      BIGMODEL_API_BASE_URL: " ",
      BIGMODEL_TEST_API_BASE_URL: "",
    };

    expect(resolveRuntimeProductEndpointConfig(env)).toMatchObject({
      codezEndpointOrigin: TEST_CODEZ_ENDPOINT_ORIGIN,
      zaiOAuthOrigin: TEST_ZAI_OAUTH_ORIGIN,
      zaiBusinessBaseUrl: TEST_ZAI_BUSINESS_BASE_URL,
      zaiOAuthClientId: TEST_ZAI_OAUTH_CLIENT_ID,
      bigModelApiOrigin: TEST_BIGMODEL_API_ORIGIN,
    });
  });

  it("rejects non-http endpoint origins", () => {
    expect(() => normalizeCodezEndpointOrigin("file:///tmp/codez")).toThrow(/http or https/);
  });

  it("persists optional endpoint override in app settings", () => {
    expect(
      appSettingsSchema.parse({ codezEndpointOrigin: "https://zcode.z.ai/path" })
        .codezEndpointOrigin,
    ).toBe(TEST_CODEZ_ENDPOINT_ORIGIN);
    expect(
      appSettingsPatchSchema.parse({ codezEndpointOrigin: "http://localhost:3030/foo" })
        .codezEndpointOrigin,
    ).toBe("http://localhost:3030");
  });
});
