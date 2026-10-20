import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { CodezIntlProvider, useCodezIntl } from "@/i18n/IntlProvider.js";
import {
  CodexUsageObservationSummary,
  CODEX_APP_USAGE_OBSERVATION_COPY_ID,
} from "./AppUsagePanel.js";
import { CodexOnlyUsageView } from "./CodexOnlyUsagePanel.js";
import {
  buildCodexUsageObservationTotals,
  normalizeCodexUsageThreads,
} from "./codexUsageThreads.js";

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
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  });
  // 缺一个线程的事实不能把部分合计展示成全量值。
  const empty = buildCodexUsageObservationTotals([]);
  assert.equal(empty.threads, 0);
  assert.equal(empty.inputTokens, null);
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
    threads: [
      {
        threadId: "thread",
        observation: {
          observationId: "observation",
          payload: { inputTokens: 10 },
        },
        conflict: true,
      },
    ],
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
  assert.match(html, /--/);

  const empty = renderToStaticMarkup(
    <CodezIntlProvider initialLocale="en-US">
      <IntlSummaryFixture
        observations={{ ...snapshot, threads: [], conflict: true, stale: true }}
      />
    </CodezIntlProvider>,
  );
  assert.doesNotMatch(empty, /disconnected/);
  assert.doesNotMatch(empty, /regressed/);
});

test("Codex-only usage shows observed facts without legacy errors or invented zeros", () => {
  const view = (snapshot: Parameters<typeof CodexOnlyUsageView>[0]["snapshot"]) =>
    renderToStaticMarkup(
      <CodezIntlProvider initialLocale="en-US">
        <CodexOnlyUsageView snapshot={snapshot} error={null} onRefresh={() => {}} />
      </CodezIntlProvider>,
    );
  const observed = view({
    threads: [
      {
        threadId: "native",
        observation: { payload: { inputTokens: 24, outputTokens: 12 } },
        conflict: false,
      },
    ],
    conflict: false,
    stale: false,
  });
  assert.match(observed, /Observed Codex threads/);
  assert.match(observed, /24/);
  assert.match(observed, /--.*Observed cache-read tokens/s);
  assert.match(observed, /--.*Observed cache-write tokens/s);
  assert.doesNotMatch(observed, /Unable to load usage stats|No usage data yet/);
  assert.doesNotMatch(observed, /Last 7 days|Total tokens/);
  const empty = view({ threads: [], conflict: false, stale: false });
  assert.match(empty, /No observed Codex threads yet/);
  assert.doesNotMatch(empty, /Observed input tokens/);
});

test("RPC snapshot normalizes arrays, legacy Maps and malformed shapes without a render crash", () => {
  const state = { observation: { payload: { inputTokens: 10 } }, conflict: true };
  const array = [{ threadId: "thread", ...state }];
  assert.deepEqual(normalizeCodexUsageThreads(array), array);
  assert.deepEqual(normalizeCodexUsageThreads(new Map([["thread", state]])), array);
  assert.deepEqual(normalizeCodexUsageThreads({}), []);
  assert.deepEqual(normalizeCodexUsageThreads([{ threadId: "bad", observation: null }]), []);
  assert.deepEqual(normalizeCodexUsageThreads(new Map([["bad", { observation: {} }]])), []);
});
