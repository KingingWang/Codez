import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodezTaskMeta } from "@codez/shared";
import zh from "@/i18n/locales/zh-CN.js";
import { WorkspaceLastActivity } from "@/WorkspaceHeaderSections/WorkspaceLastActivity.js";
vi.mock("@/i18n/IntlProvider.js", () => ({
  useCodezIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values: Record<string, unknown> = {}) =>
        zh[id]!.replace(/\{(\w+)\}/g, (_, key) => String(values[key])),
    },
  }),
}));
afterEach(() => vi.useRealTimers());
describe("current task last activity", () => {
  it("uses current task updatedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    expect(
      renderToStaticMarkup(
        createElement(WorkspaceLastActivity, { task: { updatedAt: 880_000 } as CodezTaskMeta }),
      ),
    ).toContain("最近活动 2 分钟前");
  });
  it("prefers live activity over stored metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const task = {
      updatedAt: 1,
      __codezSessionActivity: { lastActivityAt: 999_000 },
    } as unknown as CodezTaskMeta;
    expect(renderToStaticMarkup(createElement(WorkspaceLastActivity, { task }))).toContain(
      "最近活动 刚刚",
    );
  });
  it("does not invent a timestamp for a missing task", () => {
    expect(renderToStaticMarkup(createElement(WorkspaceLastActivity, { task: null }))).toBe("");
  });
});
