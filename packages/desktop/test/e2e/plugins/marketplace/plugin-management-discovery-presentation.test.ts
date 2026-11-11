import { clearAppData, clickTestIdByDom, setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";
import {
  PLUGIN_LIFECYCLE_NAME,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  PLUGIN_OFFICIAL_INCOMPATIBLE_ID,
  PLUGIN_OFFICIAL_WARNING_ID,
  addLifecycleMarketplaceThroughUi,
  assertPluginStoreFitsViewport,
  capturePluginManualReview,
  clickPluginControl,
  createPluginLifecycleFixture,
  getPluginControlText,
  getPluginOverview,
  getCurrentRendererWorkspacePath,
  hasPluginControl,
  installPluginThroughUi,
  openManageView,
  openPluginCard,
  requirePluginManualReview,
  seedOfficialCompatibilityCache,
  setPluginPresentation,
  attemptOfficialIncompatibleInstall,
  waitForPluginControl,
  waitForPluginCard,
} from "#e2e/helpers/plugin-management-lifecycle";

const DISCOVERY_TIMEOUT_MS = 180000;

describe("PLM-LC-001/002 插件商店发现、入口与展示 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("覆盖默认分段、搜索、折叠、Card/Manage 入口与 pairwise 展示", async function () {
    this.timeout(DISCOVERY_TIMEOUT_MS);
    requirePluginManualReview();

    const fixture = await createPluginLifecycleFixture();
    await seedOfficialCompatibilityCache();
    // 启动固定落在 conversation workspace；Settings scope 的浏览入口受 active workspace 设备判定影响。
    // 商店是 WorkspaceShell 主视图，本用例直接走侧栏真实入口，避免把 scope 菜单独立缺陷混入商店断言。
    await clickTestIdByDom("plugin-store-sidebar-open");
    await waitForPluginControl("plugin-store-root", {}, 30000);
    await waitForPluginControl("plugin-store-list", {}, 30000);
    await setPluginPresentation({ locale: "zh-CN", theme: "zai-light", width: 1440, height: 720 });

    expect(await isPressed("plugin-store-segment-public")).toBe(true);
    await waitForPluginCard(PLUGIN_OFFICIAL_INCOMPATIBLE_ID);
    await waitForPluginCard(PLUGIN_OFFICIAL_WARNING_ID);
    expect(
      await getPluginControlText("plugin-store-card", {
        pluginId: PLUGIN_OFFICIAL_INCOMPATIBLE_ID,
      }),
    ).toContain("这个官方插件暂不支持 Codex。");
    expect(
      await browser
        .$(
          `[data-testid="plugin-store-install"][data-plugin-id="${PLUGIN_OFFICIAL_INCOMPATIBLE_ID}"]`,
        )
        .isEnabled(),
    ).toBe(false);
    expect(
      await getPluginControlText("plugin-store-card", { pluginId: PLUGIN_OFFICIAL_WARNING_ID }),
    ).toContain("部分功能在 Codex 中不可用");

    await openPluginCard(PLUGIN_OFFICIAL_INCOMPATIBLE_ID);
    expect(
      await getPluginControlText("plugin-store-detail", {
        pluginId: PLUGIN_OFFICIAL_INCOMPATIBLE_ID,
      }),
    ).toContain("这个官方插件暂不支持 Codex。");
    expect(
      await browser
        .$(
          `[data-testid="plugin-store-install"][data-plugin-id="${PLUGIN_OFFICIAL_INCOMPATIBLE_ID}"]`,
        )
        .isEnabled(),
    ).toBe(false);
    expect(
      await hasPluginControl("plugin-store-example-prompt", {
        pluginId: PLUGIN_OFFICIAL_INCOMPATIBLE_ID,
      }),
    ).toBe(false);
    const install = await attemptOfficialIncompatibleInstall();
    expect(install.ok).toBe(false);
    expect(install.error).toContain("This plugin is not compatible with Codex");
    expect(
      (await getPluginOverview(await getCurrentRendererWorkspacePath())).installedPlugins.some(
        (plugin) => plugin.id === PLUGIN_OFFICIAL_INCOMPATIBLE_ID,
      ),
    ).toBe(false);
    expect(
      await hasPluginControl("plugin-store-detail", {
        pluginId: PLUGIN_OFFICIAL_INCOMPATIBLE_ID,
      }),
    ).toBe(true);
    await clickPluginControl("plugin-store-detail-back");
    await openPluginCard(PLUGIN_OFFICIAL_WARNING_ID);
    expect(
      await getPluginControlText("plugin-store-detail", {
        pluginId: PLUGIN_OFFICIAL_WARNING_ID,
      }),
    ).toContain("部分功能在 Codex 中不可用");
    expect(
      await browser
        .$(`[data-testid="plugin-store-install"][data-plugin-id="${PLUGIN_OFFICIAL_WARNING_ID}"]`)
        .isEnabled(),
    ).toBe(true);
    await clickPluginControl("plugin-store-detail-back");
    await addLifecycleMarketplaceThroughUi(fixture);
    const lifecycleOverview = await getPluginOverview(await getCurrentRendererWorkspacePath());
    expect(
      lifecycleOverview.marketplaces.some(
        (marketplace) => marketplace.id === PLUGIN_LIFECYCLE_MARKETPLACE_ID,
      ),
    ).toBe(true);
    expect(
      lifecycleOverview.availablePlugins.some((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID),
    ).toBe(true);
    await clickPluginControl("plugin-store-segment-personal");
    expect(await isPressed("plugin-store-segment-personal")).toBe(true);
    await waitForPluginCard(PLUGIN_LIFECYCLE_ID, 60000);

    await setInputValueByTestIdDom("plugin-store-search", PLUGIN_LIFECYCLE_NAME);
    await waitForPluginCard(PLUGIN_LIFECYCLE_ID);
    expect(await getPluginControlText("plugin-store-list")).toContain("Lifecycle Fixture");
    await setInputValueByTestIdDom("plugin-store-search", "");

    const groupKey = `marketplace:${PLUGIN_LIFECYCLE_MARKETPLACE_ID}`;
    await waitForPluginControl("plugin-store-group-toggle", { groupKey });
    expect(await countPluginCards()).toBeGreaterThanOrEqual(8);
    await clickPluginControl("plugin-store-group-toggle", { groupKey });
    expect(await countPluginCards()).toBe(6);
    await clickPluginControl("plugin-store-group-toggle", { groupKey });
    expect(await countPluginCards()).toBeGreaterThanOrEqual(8);

    await setInputValueByTestIdDom("plugin-store-search", PLUGIN_LIFECYCLE_NAME);
    await setMainScrollTop(180);
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await capturePluginManualReview("PLM-LC-001", "detail-from-card");
    await clickPluginControl("plugin-store-detail-back");
    expect(await inputValue("plugin-store-search")).toBe(PLUGIN_LIFECYCLE_NAME);
    expect(await isPressed("plugin-store-segment-personal")).toBe(true);
    expect(await mainScrollTop()).toBeGreaterThanOrEqual(0);

    await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);
    await setInputValueByTestIdDom("plugin-store-search", "");
    expect(await hasPluginControl("plugin-store-installed-strip")).toBe(false);
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await waitForPluginControl("plugin-store-detail", { pluginId: PLUGIN_LIFECYCLE_ID });
    await clickPluginControl("plugin-store-detail-back");
    await openManageView();
    await waitForPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_LIFECYCLE_ID });
    await capturePluginManualReview("PLM-LC-001", "manage-installed");
    await clickPluginControl("plugin-store-manage-back");

    await assertPluginStoreFitsViewport();
    await capturePluginManualReview("PLM-LC-002", "zh-zai-light-wide");
    await setPluginPresentation({ locale: "en-US", theme: "zai-dark", width: 720, height: 720 });
    await assertPluginStoreFitsViewport();
    expect(await hasPluginControl("plugin-store-create")).toBe(true);
    expect(await hasPluginControl("plugin-store-sources-open")).toBe(true);
    await capturePluginManualReview("PLM-LC-002", "en-zai-dark-narrow");
    await clickPluginControl("desktop-top-nav-back");
    await browser.waitUntil(async () => !(await hasPluginControl("plugin-store-root")), {
      timeout: 15000,
      timeoutMsg: "Market Back did not return to the chat view",
    });
    expect(await hasPluginControl("plugin-settings-scope-trigger")).toBe(false);
    await capturePluginManualReview("PLM-LC-001", "back-to-chat");
  });
});

async function isPressed(testIdValue: string): Promise<boolean> {
  return browser.execute(
    (id) =>
      document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.getAttribute("aria-pressed") ===
      "true",
    testIdValue,
  );
}

async function countPluginCards(): Promise<number> {
  return browser.execute(
    () => document.querySelectorAll('[data-testid="plugin-store-card"]').length,
  );
}

async function inputValue(testIdValue: string): Promise<string> {
  return browser.execute(
    (id) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)?.value ?? "",
    testIdValue,
  );
}

async function setMainScrollTop(value: number): Promise<void> {
  await browser.execute((next) => {
    const root = document.querySelector<HTMLElement>('[data-testid="plugin-store-root"]');
    const main = root?.closest("main");
    if (main) main.scrollTop = next;
  }, value);
}

async function mainScrollTop(): Promise<number> {
  return browser.execute(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="plugin-store-root"]');
    return root?.closest("main")?.scrollTop ?? 0;
  });
}
