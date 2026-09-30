import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodezIntlProvider, useCodezIntl } from "@/i18n/IntlProvider.js";
import { CodexRetryStatus } from "./CodexRetryStatus.js";

function RetryStatus({ httpStatusCode }: { httpStatusCode: number | null }) {
  const { intl } = useCodezIntl();
  return <CodexRetryStatus httpStatusCode={httpStatusCode} intl={intl} />;
}

test("reported Codex HTTP retry is readable in English without inventing attempt counts", () => {
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
});
