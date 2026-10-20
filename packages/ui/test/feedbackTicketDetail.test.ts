import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FeedbackTicketDetail } from "@codez/shared";
import type { IFeedbackService } from "@codez/services";

import { TicketDetailView } from "@/feedback/TicketDetail.js";
import { CodezIntlProvider } from "@/i18n/IntlProvider.js";

function createTicket(): FeedbackTicketDetail {
  return {
    id: "ticket-1",
    title: "312312",
    type: "bug",
    status: "已提交",
    created_at: "2026-06-07T04:00:00.000Z",
    updated_at: "2026-06-07T04:01:00.000Z",
    description: "desc",
    attachments: [],
    comments: [],
    events: [
      {
        id: 1,
        ticket_id: 1,
        type: "created",
        summary: "反馈已提交",
        payload: {},
        created_at: "2026-06-07T04:00:00.000Z",
      },
      {
        id: 2,
        ticket_id: 1,
        type: "user_replied",
        summary: "你补充了信息",
        payload: {},
        created_at: "2026-06-07T04:01:00.000Z",
      },
    ],
  };
}

describe("TicketDetailView", () => {
  it("localizes the latest process summary card in English", () => {
    const html = renderToStaticMarkup(
      createElement(
        CodezIntlProvider,
        { initialLocale: "en-US" },
        createElement(TicketDetailView, {
          ticket: createTicket(),
          feedbackService: {} as IFeedbackService,
          onRefresh: vi.fn(),
          onOpenProcess: vi.fn(),
        }),
      ),
    );

    expect(html).toContain("You added information");
    expect(html).not.toContain("你补充了信息");
  });

  it("shows the localized issue id prefix with a copy action", () => {
    const html = renderToStaticMarkup(
      createElement(
        CodezIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(TicketDetailView, {
          ticket: createTicket(),
          feedbackService: {} as IFeedbackService,
          onRefresh: vi.fn(),
          onOpenProcess: vi.fn(),
        }),
      ),
    );

    expect(html).toContain("ID");
    expect(html).toContain("ticket-1");
    expect(html).toContain('aria-label="复制 issue 编号"');
  });

  it("uses the English issue id prefix in English", () => {
    const html = renderToStaticMarkup(
      createElement(
        CodezIntlProvider,
        { initialLocale: "en-US" },
        createElement(TicketDetailView, {
          ticket: createTicket(),
          feedbackService: {} as IFeedbackService,
          onRefresh: vi.fn(),
          onOpenProcess: vi.fn(),
        }),
      ),
    );

    expect(html).toContain("Issue #");
    expect(html).toContain("ticket-1");
    expect(html).toContain('aria-label="Copy issue ID"');
  });
});
