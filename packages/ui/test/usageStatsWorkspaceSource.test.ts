// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUsageSnapshot } from "@codez/shared";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { UsageStatsSection } from "@/settings/UsageStatsSection.js";
import { AppUsagePanel, useCodexUsageObservations } from "@/settings/usage-stats/AppUsagePanel.js";

const resolution = {
  services: undefined as unknown,
  remoteSessionId: null as string | null,
  isRemoteTarget: false,
  connectionKind: "local-ready" as "local-ready" | "remote-waiting" | "remote-ready",
  rpcReady: true,
};

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: vi.fn(() => resolution),
}));

function snapshot(totalTokens: number): AppUsageSnapshot {
  return {
    range: "7d",
    generatedAt: 0,
    timeZone: "UTC",
    source: "agent-db",
    summary: {
      totalTokens,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      totalSessions: 0,
      totalTurns: 0,
      toolCallCount: 0,
      toolErrorRate: 0,
      modelErrorRate: 0,
      avgTimeToFirstTokenMs: null,
      avgTurnDurationMs: null,
      activeDays: 0,
      currentStreakDays: 0,
      longestSessionMs: 0,
      longestStreakDays: 0,
      peakDayTokens: 0,
      favoriteModel: null,
    },
    heatmap: { startDate: null, endDate: null, maxTokens: 0, weeks: [] },
    dailyModelUsage: [],
    models: [],
    tools: [],
  };
}

function createServices(id: string, totalTokens: number, fail = false) {
  return {
    usageStatsService: {
      id,
      getAppUsageSnapshot: vi.fn(async () => {
        if (fail) throw new Error("remote disconnected");
        return snapshot(totalTokens);
      }),
    },
  } as never;
}

function renderSection(services: unknown, connectionKind: typeof resolution.connectionKind) {
  resolution.services = services;
  resolution.connectionKind = connectionKind;
  const isRemote = connectionKind !== "local-ready";
  return render(
    createElement(
      ServiceProvider,
      { services: createServices("context", 1) },
      createElement(
        CodezIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(UsageStatsSection, {
          workspaceIdentity: isRemote ? "remote:server:source-a:/project" : undefined,
          workspacePath: "/project",
          remoteSessionId: connectionKind === "local-ready" ? null : "session-a",
          remoteTarget: isRemote
            ? { kind: "server", name: "server-a", sourceServerId: "source-a" }
            : undefined,
        }),
      ),
    ),
  );
}

afterEach(() => {
  cleanup();
  resolution.services = undefined;
  resolution.remoteSessionId = null;
  resolution.isRemoteTarget = false;
  resolution.connectionKind = "local-ready";
  resolution.rpcReady = true;
});

describe("UsageStatsSection workspace source", () => {
  it("远程 workspace 使用远端 accessor，并显示远程来源", async () => {
    renderSection(createServices("remote", 200), "remote-ready");

    expect(await screen.findByText("200")).toBeTruthy();
    expect(screen.getByTestId("usage-stats-source").textContent).toContain(
      "数据来源：server-a（远程）",
    );
  });

  it("本地 workspace 使用当前 services，并显示本机来源", async () => {
    renderSection(createServices("local", 100), "local-ready");

    expect(await screen.findByText("100")).toBeTruthy();
    expect(screen.getByTestId("usage-stats-source").textContent).toContain("本机");
  });

  it("远程断开或等待时不回退本机，显示错误且无本机数据", async () => {
    const disconnected = createServices("disconnected", 999, true);
    const context = createServices("context", 1);
    const contextGetAppUsageSnapshot = context.usageStatsService.getAppUsageSnapshot;
    renderSection(disconnected, "remote-waiting");

    await waitFor(
      () => {
        expect(disconnected.usageStatsService.getAppUsageSnapshot).toHaveBeenCalledTimes(2);
      },
      { timeout: 3000 },
    );
    expect(contextGetAppUsageSnapshot).not.toHaveBeenCalled();
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.queryByText("999")).toBeNull();
    expect(screen.getByTestId("usage-stats-source").textContent).not.toContain("本机");
  });

  it("App snapshots 和 Codex observations 使用同一个远端 usageStatsService", async () => {
    const remote = createServices("remote", 200);
    remote.usageStatsService.getCodexUsageObservations = vi.fn(async () => ({
      threads: [],
      conflict: false,
      stale: false,
    }));
    const target = remote.usageStatsService;
    function ObservationsProbe() {
      useCodexUsageObservations({
        workspacePath: "/project",
        workspaceIdentity: "remote:server:source-a:/project",
        usageStatsService: target,
      });
      return null;
    }

    render(
      createElement(
        ServiceProvider,
        { services: createServices("context-observations", 1) },
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ObservationsProbe),
        ),
      ),
    );
    render(
      createElement(
        ServiceProvider,
        { services: createServices("context", 1) },
        createElement(
          CodezIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(AppUsagePanel, { usageStatsService: target }),
        ),
      ),
    );

    expect(await screen.findByText("200")).toBeTruthy();
    expect(target.getAppUsageSnapshot).toHaveBeenCalledTimes(2);
    expect(target.getCodexUsageObservations).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: "/project" }),
    );
  });
});
