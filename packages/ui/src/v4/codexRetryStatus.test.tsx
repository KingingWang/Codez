import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodezIntlProvider, useCodezIntl } from "@/i18n/IntlProvider.js";
import { CodexRetryStatus } from "./CodexRetryStatus.js";

function RetryStatus({
  httpStatusCode,
  attempt = null,
  maxRetries = null,
}: {
  httpStatusCode: number | null;
  attempt?: number | null;
  maxRetries?: number | null;
}) {
  const { intl } = useCodezIntl();
  return (
    <CodexRetryStatus
      httpStatusCode={httpStatusCode}
      attempt={attempt}
      maxRetries={maxRetries}
      intl={intl}
    />
  );
}

test("reported Codex HTTP retry renders attempt/maxRetries in English and Chinese when provided", () => {
  const enHtml = renderToStaticMarkup(
    <CodezIntlProvider initialLocale="en-US">
      <RetryStatus httpStatusCode={403} attempt={1} maxRetries={5} />
    </CodezIntlProvider>,
  );
  assert.match(enHtml, /role="status"/);
  assert.match(enHtml, /Model request retrying\.\.\. 1\/5 · HTTP 403/);

  const zhHtml = renderToStaticMarkup(
    <CodezIntlProvider initialLocale="zh-CN">
      <RetryStatus httpStatusCode={403} attempt={1} maxRetries={5} />
    </CodezIntlProvider>,
  );
  assert.match(zhHtml, /模型请求正在重试… 1\/5 · HTTP 403/);
});

test("reported Codex HTTP retry is readable in English without inventing attempt counts when none are reported", () => {
  const html = renderToStaticMarkup(
    <CodezIntlProvider initialLocale="en-US">
      <RetryStatus httpStatusCode={503} />
    </CodezIntlProvider>,
  );
  assert.match(html, /role="status"/);
  assert.match(html, /Model request retrying\.\.\. · HTTP 503/);
  assert.doesNotMatch(html, /1\/5/);
});

test("Chinese retry without a native HTTP code remains localized and code-free", () => {
  const html = renderToStaticMarkup(
    <CodezIntlProvider initialLocale="zh-CN">
      <RetryStatus httpStatusCode={null} />
    </CodezIntlProvider>,
  );
  assert.match(html, /模型请求正在重试…/);
  assert.doesNotMatch(html, /HTTP|null|undefined/);

  const withCountsHtml = renderToStaticMarkup(
    <CodezIntlProvider initialLocale="zh-CN">
      <RetryStatus httpStatusCode={null} attempt={2} maxRetries={5} />
    </CodezIntlProvider>,
  );
  assert.match(withCountsHtml, /模型请求正在重试… 2\/5/);
  assert.doesNotMatch(withCountsHtml, /HTTP|null|undefined/);
});
