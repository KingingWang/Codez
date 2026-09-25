import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { CodezIntlProvider, useCodezIntl } from "@/i18n/IntlProvider.js";
import {
  buildCodexUsageObservationTotals,
  CodexUsageObservationSummary,
  CODEX_APP_USAGE_OBSERVATION_COPY_ID,
} from "./AppUsagePanel.js";

test("app usage copy states desktop observation and excludes official billing", () => {
  const english = enUS[CODEX_APP_USAGE_OBSERVATION_COPY_ID];
  const chinese = zhCN[CODEX_APP_USAGE_OBSERVATION_COPY_ID];
  assert.ok(english);
  assert.ok(chinese);
  assert.match(english, /desktop-observed telemetry/i);
  assert.match(english, /not an official billing statement/i);
  assert.match(chinese, /桌面本地观察统计/);
  assert.match(chinese, /不是官方计费账单/);
});

test("app usage renders explicit desktop-observed Codex totals separately from agent-db usage", () => {
  const totals = buildCodexUsageObservationTotals([
    {
      observation: {
        observationId: "a",
        payload: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
      },
      conflict: false,
    },
    {
      observation: {
        observationId: "b",
        payload: { inputTokens: 3, cacheWriteTokens: 4 },
      },
      conflict: false,
    },
  ] as unknown as Parameters<typeof buildCodexUsageObservationTotals>[0]);
  assert.deepEqual(totals, {
    threads: 2,
    inputTokens: 13,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 4,
  });
  // Absent facts remain unavailable at thread level and do not inflate the observed totals.
  const empty = buildCodexUsageObservationTotals([]);
  assert.equal(empty.threads, 0);
});

function IntlSummaryFixture({
  observations,
}: {
  observations: Parameters<typeof CodexUsageObservationSummary>[0]["observations"];
}) {
  const { intl, locale } = useCodezIntl();
  return <CodexUsageObservationSummary observations={observations} intl={intl} locale={locale} />;
}

test("app usage renders cache-owned Codex staleness and conflict without zeroing sparse facts", () => {
  const snapshot = {
    workspaceKey: "workspace",
    threads: new Map([
      [
        "thread",
        {
          observation: {
            observationId: "observation",
            payload: { inputTokens: 10 },
          },
          conflict: true,
        },
      ],
    ]),
    conflict: true,
    stale: true,
  };
  const html = renderToStaticMarkup(
    <CodezIntlProvider initialLocale="en-US">
      <IntlSummaryFixture observations={snapshot} />
    </CodezIntlProvider>,
  );
  assert.match(html, /Observed Codex threads/);
  assert.match(html, /disconnected/);
  assert.match(html, /regressed/);

  const empty = renderToStaticMarkup(
    <CodezIntlProvider initialLocale="en-US">
      <IntlSummaryFixture
        observations={{ ...snapshot, threads: new Map(), conflict: true, stale: true }}
      />
    </CodezIntlProvider>,
  );
  assert.doesNotMatch(empty, /disconnected/);
  assert.doesNotMatch(empty, /regressed/);
});
