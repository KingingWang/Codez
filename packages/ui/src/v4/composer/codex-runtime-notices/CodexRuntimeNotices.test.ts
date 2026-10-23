import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodexRuntimeNotices } from "./index.js";

test("Codex runtime notices render native text without interpreting markup", () => {
  const html = renderToStaticMarkup(
    createElement(CodexRuntimeNotices, {
      notices: [
        {
          id: "n1",
          kind: "warning",
          message: "warning <token>",
          detail: "details & guidance",
          at: 1,
        },
        {
          id: "n2",
          kind: "authRecovery",
          message: "recovering",
          provider: "openai",
          turnId: "turn-1",
          phase: "started",
          at: 2,
        },
        {
          id: "n3",
          kind: "authRecovery",
          message: "recovered",
          provider: "openai",
          turnId: "turn-1",
          phase: "completed",
          at: 3,
        },
      ],
    }),
  );
  assert.match(html, /warning &lt;token&gt;/);
  assert.match(html, /details &amp; guidance/);
  assert.match(html, /data-notice-phase="started"/);
  assert.match(html, /data-notice-phase="completed"/);
  assert.match(html, /bg-warning-surface/);
  assert.match(html, /bg-success-surface/);
  assert.doesNotMatch(html, /<token>/);
  assert.equal(renderToStaticMarkup(createElement(CodexRuntimeNotices, { notices: [] })), "");
});
