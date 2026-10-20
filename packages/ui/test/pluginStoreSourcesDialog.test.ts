// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { AddMarketplaceSourceDialog } from "@/settings/AddMarketplaceSourceDialog.js";
import {
  PluginStoreSourceRefreshFailure,
  PluginStoreSourcesDialog,
} from "@/settings/PluginStoreSourcesDialog.js";

afterEach(() => {
  cleanup();
});

describe("PluginStoreSourcesDialog", () => {
  it("shows the persisted marketplace refresh failure beside its source", () => {
    const html = renderToStaticMarkup(
      createElement(
        CodezIntlProvider,
        { initialLocale: "en-US" },
        createElement(PluginStoreSourceRefreshFailure, {
          failure: {
            code: "plugin_archive_fetch_failed",
            failedAt: "2026-08-06T03:55:00.000Z",
            message: "Archive download timed out",
          },
        }),
      ),
    );

    expect(html).toContain("Archive download timed out");
    expect(html).toContain("Refresh failed");
  });

  // claude-plugins-official 的刷新失败不提示（任何原因）；其它来源仍显示失败行。
  it("hides the refresh failure of claude-plugins-official but keeps it for other sources", () => {
    const failure = {
      code: "plugin_marketplace_invalid",
      failedAt: "2026-08-06T03:55:00.000Z",
      message: "git clone failed",
    };
    render(
      createElement(
        CodezIntlProvider,
        { initialLocale: "en-US" },
        createElement(PluginStoreSourcesDialog, {
          open: true,
          onOpenChange: () => {},
          marketplaces: [
            {
              id: "claude-plugins-official",
              name: "claude-plugins-official",
              source: {},
              pluginCount: 0,
              refreshFailure: failure,
            },
            {
              id: "codez-labs",
              name: "codez-labs",
              source: {},
              pluginCount: 0,
              refreshFailure: failure,
            },
          ],
          onUpdateMarketplace: () => {},
          onRemoveMarketplace: () => {},
          activeOperations: [],
        }),
      ),
    );

    const failures = screen.getAllByTestId("plugin-store-source-refresh-failure");
    expect(failures).toHaveLength(1);
    expect(
      failures[0]!
        .closest("[data-testid='plugin-store-source-row']")
        ?.getAttribute("data-marketplace-id"),
    ).toBe("codez-labs");
  });

  it("renders an add failure inside the add marketplace dialog", () => {
    render(
      createElement(
        CodezIntlProvider,
        { initialLocale: "en-US" },
        createElement(AddMarketplaceSourceDialog, {
          open: true,
          onOpenChange: () => {},
          onAddMarketplace: async () => false,
          activeOperations: [],
          error: "Invalid marketplace source",
        }),
      ),
    );

    expect(screen.getByTestId("plugin-store-add-source-dialog")).toBeTruthy();
    expect(screen.getByTestId("plugin-store-add-source-error").textContent).toContain(
      "Invalid marketplace source",
    );
  });

  it("renders official sources first and custom sources by lastUpdated", () => {
    render(
      createElement(
        CodezIntlProvider,
        { initialLocale: "en-US" },
        createElement(PluginStoreSourcesDialog, {
          open: true,
          onOpenChange: () => {},
          marketplaces: [
            {
              id: "never-refreshed",
              name: "Never Refreshed",
              source: {},
              pluginCount: 0,
            },
            {
              id: "codez-plugins-test",
              name: "codez-plugins-test",
              source: {},
              pluginCount: 0,
              lastUpdated: "2026-08-20T12:00:00Z",
            },
            {
              id: "claude-plugins-official",
              name: "claude-plugins-official",
              source: {},
              pluginCount: 0,
              lastUpdated: "2026-01-01T00:00:00Z",
            },
            {
              id: "codez-plugins-official",
              name: "codez-plugins-official",
              source: {},
              pluginCount: 0,
              lastUpdated: "2026-08-20T23:00:00Z",
            },
            {
              id: "codez-labs",
              name: "codez-labs",
              source: {},
              pluginCount: 0,
              lastUpdated: "2026-08-20T12:00:00Z",
            },
          ],
          onUpdateMarketplace: () => {},
          onRemoveMarketplace: () => {},
          activeOperations: [],
        }),
      ),
    );

    expect(
      screen
        .getAllByTestId("plugin-store-source-row")
        .map((row) => row.getAttribute("data-marketplace-id")),
    ).toEqual([
      "codez-plugins-official",
      "claude-plugins-official",
      "codez-labs",
      "codez-plugins-test",
      "never-refreshed",
    ]);
  });
});
