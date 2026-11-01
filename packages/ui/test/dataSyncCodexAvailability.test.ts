// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@codez/services";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { selectDataSyncCategories } from "@/data-sync/app/categories.js";
import { createPluginCategoryDataSyncService } from "@/data-sync/app/marketplacePluginSync.js";
import { useDataSyncRuntimeModes } from "@/data-sync/app/useDataSyncRuntimeModes.js";
import type { DataSyncCategoryId } from "@/data-sync/contract.js";
import {
  DATA_SYNC_CODEX_CATEGORY_EFFECT,
  resolveDataSyncCategoryBadge,
  resolveDataSyncCodexAvailability,
  type DataSyncCodexCategoryEffect,
} from "@/data-sync/domain/codexBackend.js";
import {
  DataSyncCodexBanners,
  DataSyncCodexBlockedPanel,
  DataSyncCodexCategoryBadge,
  DataSyncCodexPartialNotice,
  DataSyncCodexSectionNotice,
} from "@/data-sync/ui/DataSyncCodexNotices.js";

type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/** 直接读 locale 表：缺少文案就抛错，顺带保证组件引用的 key 都存在。 */
function createFormatMessage(messages: Record<string, string>): FormatMessage {
  return ({ id }, values) => {
    const template = messages[id];
    if (template === undefined) throw new Error(`missing message: ${id}`);
    return Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
      template,
    );
  };
}

const BLOCKED_CATEGORIES = (
  Object.entries(DATA_SYNC_CODEX_CATEGORY_EFFECT) as Array<
    [DataSyncCategoryId, DataSyncCodexCategoryEffect]
  >
)
  .filter(([, effect]) => effect === "none")
  .map(([id]) => id);

describe("resolveDataSyncCodexAvailability", () => {
  it("keeps every category syncable when neither end runs Codex", () => {
    const availability = resolveDataSyncCodexAvailability({
      sourceMode: "legacy",
      targetMode: "legacy",
    });
    expect(availability.sourceNotice).toBe(false);
    expect(availability.targetNotice).toBe(false);
    expect(availability.blocked.size).toBe(0);
    expect(availability.partial.size).toBe(0);
    expect(availability.inlinePlugins).toBe(true);
  });

  it("treats an unresolved runtime mode as legacy so nothing gets blocked by mistake", () => {
    for (const targetMode of ["pending", "legacy"] as const) {
      const availability = resolveDataSyncCodexAvailability({
        sourceMode: "pending",
        targetMode,
      });
      expect(availability.blocked.size).toBe(0);
      expect(availability.sourceNotice).toBe(false);
    }
  });

  it("only warns about the local listing when just the source runs Codex", () => {
    const availability = resolveDataSyncCodexAvailability({
      sourceMode: "codex",
      targetMode: "legacy",
    });
    // 数据仍然会正确落到 legacy 目标端的 Codez 运行时，因此不能禁用推送。
    expect(availability.sourceNotice).toBe(true);
    expect(availability.targetNotice).toBe(false);
    expect(availability.blocked.size).toBe(0);
    expect(availability.inlinePlugins).toBe(true);
  });

  it("blocks the Codez-storage-only categories when the device runs Codex", () => {
    const availability = resolveDataSyncCodexAvailability({
      sourceMode: "legacy",
      targetMode: "codex",
    });
    expect(availability.targetNotice).toBe(true);
    expect([...availability.blocked].sort()).toEqual([...BLOCKED_CATEGORIES].sort());
    expect([...availability.partial]).toEqual(["plugins"]);
    expect(availability.inlinePlugins).toBe(false);
    expect(resolveDataSyncCategoryBadge(availability, "mcp")).toBe("blocked");
    expect(resolveDataSyncCategoryBadge(availability, "plugins")).toBe("partial");
  });

  it("reports both notices when both ends run Codex", () => {
    const availability = resolveDataSyncCodexAvailability({
      sourceMode: "codex",
      targetMode: "codex",
    });
    expect(availability.sourceNotice).toBe(true);
    expect(availability.targetNotice).toBe(true);
  });
});

describe("selectDataSyncCategories", () => {
  it("drops the blocked categories and keeps marketplace-only plugins", () => {
    const syncable = selectDataSyncCategories(
      resolveDataSyncCodexAvailability({ sourceMode: "codex", targetMode: "codex" }),
    );
    expect(syncable.map((category) => category.id)).toEqual(["plugins"]);
  });

  it("keeps the upstream category list when the device is not Codex", () => {
    const syncable = selectDataSyncCategories(
      resolveDataSyncCodexAvailability({ sourceMode: "codex", targetMode: "legacy" }),
    );
    expect(syncable.map((category) => category.id)).toEqual([
      "subagents",
      "plugins",
      "mcp",
      "skills",
      "commands",
      "hooks",
    ]);
  });
});

describe("plugin category under the Codex backend", () => {
  function createServices(inlineCalls: string[]) {
    return {
      systemService: {
        info: async () => ({ homedir: "/home/user", platform: "linux" }),
      },
      pluginSyncService: {
        listSyncItems: async () => {
          inlineCalls.push("list");
          return {
            items: [{ key: "local-tool@inline", name: "local-tool", enabled: true }],
            homeDir: "/home/inline",
          };
        },
      },
      pluginManagementService: {
        getPluginsOverview: async () => ({
          availablePlugins: [],
          installedPlugins: [],
          marketplaces: [],
        }),
        listPlugins: async () => ({ plugins: [] }),
      },
    } as unknown as IServiceAccessor;
  }

  it("skips the inline listing entirely when inline plugins are excluded", async () => {
    const inlineCalls: string[] = [];
    const service = createPluginCategoryDataSyncService(createServices(inlineCalls), undefined, {
      inlinePlugins: false,
    });
    const listed = await service.listSyncItems();
    // inline 插件写 ~/.codez/plugins 与 plugins.dirs，Codex 不读取；留着只会被勾选后报成功。
    expect(inlineCalls).toEqual([]);
    expect(listed.items).toEqual([]);
    expect(listed.homeDir).toBe("/home/user");
  });

  it("keeps the inline listing by default", async () => {
    const inlineCalls: string[] = [];
    const service = createPluginCategoryDataSyncService(createServices(inlineCalls));
    const listed = await service.listSyncItems();
    expect(inlineCalls).toEqual(["list"]);
    expect(listed.items.map((item) => item.key)).toEqual(["local-tool@inline"]);
    expect(listed.homeDir).toBe("/home/inline");
  });
});

describe("useDataSyncRuntimeModes", () => {
  function createServices(agentRuntimeMode: "codex" | "legacy" | undefined) {
    return {
      systemService: {
        info: vi.fn(async () => ({
          homedir: "/home/user",
          platform: "linux",
          ...(agentRuntimeMode ? { agentRuntimeMode } : {}),
        })),
      },
    } as unknown as IServiceAccessor;
  }

  it("reads each end's own host fact", async () => {
    // services 身份必须稳定（真实调用方传的是 Host accessor 与 attachment store 里的对象）：
    // 每次渲染都换对象会让解析结果永远匹配不上当前身份，停在 pending。
    const sourceServices = createServices("codex");
    const targetServices = createServices("legacy");
    const { result } = renderHook(() =>
      useDataSyncRuntimeModes({
        sourceServices,
        targetServices,
        online: true,
      }),
    );
    expect(result.current).toEqual({ source: "pending", target: "pending" });
    await waitFor(() => expect(result.current).toEqual({ source: "codex", target: "legacy" }));
  });

  it("falls back to legacy when the host does not report the mode", async () => {
    const sourceServices = createServices(undefined);
    const targetServices = createServices(undefined);
    const { result } = renderHook(() =>
      useDataSyncRuntimeModes({
        sourceServices,
        targetServices,
        online: true,
      }),
    );
    await waitFor(() => expect(result.current).toEqual({ source: "legacy", target: "legacy" }));
  });

  it("does not probe the device while it is offline", async () => {
    const info = vi.fn(async () => ({ homedir: "/home/user", platform: "linux" }));
    const targetServices = { systemService: { info } } as unknown as IServiceAccessor;
    const sourceServices = createServices("codex");
    const { result } = renderHook(() =>
      useDataSyncRuntimeModes({
        sourceServices,
        targetServices,
        online: false,
      }),
    );
    await waitFor(() => expect(result.current.source).toBe("codex"));
    expect(result.current.target).toBe("pending");
    expect(info).not.toHaveBeenCalled();
  });

  it("re-resolves when the attachment is replaced", async () => {
    const sourceServices = createServices("codex");
    const firstTarget = createServices("legacy");
    const secondTarget = createServices("codex");
    const { result, rerender } = renderHook(
      ({ targetServices }: { targetServices: IServiceAccessor }) =>
        useDataSyncRuntimeModes({ sourceServices, targetServices, online: true }),
      { initialProps: { targetServices: firstTarget } },
    );
    await waitFor(() => expect(result.current.target).toBe("legacy"));
    rerender({ targetServices: secondTarget });
    // 换代后旧结果不再代表当前 Host：先回到 pending，再由新 Host 的事实覆盖。
    expect(result.current.target).toBe("pending");
    await waitFor(() => expect(result.current.target).toBe("codex"));
  });
});

describe("Codex notices copy", () => {
  const messageIds = [
    "remoteSync.codex.targetBanner",
    "remoteSync.codex.sourceBanner",
    "remoteSync.codex.sectionNotice",
    "remoteSync.codex.blocked.title",
    "remoteSync.codex.blocked.body",
    "remoteSync.codex.badge.blocked",
    "remoteSync.codex.badge.partial",
    ...Object.keys(DATA_SYNC_CODEX_CATEGORY_EFFECT).map((id) => `remoteSync.codex.category.${id}`),
  ];

  it.each([
    ["zh-CN", zhCN],
    ["en-US", enUS],
  ])("provides every message in %s", (_locale, messages) => {
    for (const id of messageIds) {
      expect(messages[id], id).toBeTruthy();
    }
  });

  it("explains why a blocked category does not sync and where to change it", () => {
    for (const messages of [zhCN, enUS]) {
      const formatMessage = createFormatMessage(messages);
      for (const category of BLOCKED_CATEGORIES) {
        const html = renderToStaticMarkup(
          createElement(DataSyncCodexBlockedPanel, { category, formatMessage }),
        );
        expect(html).toContain("Codex");
        expect(html).toContain(".codez");
        expect(html).toContain(`remote-sync-codex-blocked-${category}`);
      }
    }
  });

  it("renders both banners and keeps their testids distinct from the badges", () => {
    const formatMessage = createFormatMessage(zhCN);
    const banners = renderToStaticMarkup(
      createElement(DataSyncCodexBanners, {
        availability: resolveDataSyncCodexAvailability({
          sourceMode: "codex",
          targetMode: "codex",
        }),
        formatMessage,
      }),
    );
    expect(banners).toContain("remote-sync-codex-target-banner");
    expect(banners).toContain("remote-sync-codex-source-banner");

    const badge = renderToStaticMarkup(
      createElement(DataSyncCodexCategoryBadge, {
        badge: "blocked",
        category: "mcp",
        scope: "nav",
        formatMessage,
      }),
    );
    expect(badge).toContain("remote-sync-codex-badge-nav-mcp");

    const partial = renderToStaticMarkup(
      createElement(DataSyncCodexPartialNotice, { category: "plugins", formatMessage }),
    );
    expect(partial).toContain("remote-sync-codex-partial-plugins");
    expect(partial).toContain("marketplace");

    const notice = renderToStaticMarkup(
      createElement(DataSyncCodexSectionNotice, { formatMessage }),
    );
    expect(notice).toContain("remote-sync-codex-section-notice");
  });

  it("renders nothing when neither end runs Codex", () => {
    const html = renderToStaticMarkup(
      createElement(DataSyncCodexBanners, {
        availability: resolveDataSyncCodexAvailability({
          sourceMode: "legacy",
          targetMode: "pending",
        }),
        formatMessage: createFormatMessage(zhCN),
      }),
    );
    expect(html).toBe("");
  });
});
