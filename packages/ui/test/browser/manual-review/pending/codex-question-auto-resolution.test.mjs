// Pending acceptance: real broker + production React + V4 commands; synthetic clock/native transport.
// Run: pnpm exec tsx --test packages/ui/test/browser/manual-review/pending/codex-question-auto-resolution.test.mjs
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
import { InteractionBroker } from "../../../../../codex-bridge/src/interactions.ts";
import { projectThread } from "../../../../../codex-bridge/src/projection.ts";
import { observeNativeQuestion } from "../../../../../codex-bridge/src/question-history.ts";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/codex-question-auto-resolution.fixture.tsx";
const START = 1_700_000_000_000;
const checks = [];
const reviewDone = Promise.withResolvers();
let server, browser, origin, artifacts, broker, state;
let now = START,
  timerId = 0;
const timers = new Map();
const questions = [
  {
    id: "target",
    header: "Target",
    question: "E2E_CSAQ34 Which target?",
    options: [{ label: "Staging", description: "Isolated" }],
  },
  {
    id: "secret",
    header: "Secret",
    question: "E2E_CSAQ34 Private answer",
    isSecret: true,
    options: [],
  },
];
const thread = () => ({
  id: "fixture-thread",
  cwd: "/workspace",
  preview: "E2E_CSAQ34",
  name: null,
  createdAt: START / 1000,
  updatedAt: START / 1000,
  modelProvider: "fixture",
  status: { type: "active", activeFlags: [] },
  turns: [
    {
      id: "fixture-turn",
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: START / 1000,
      completedAt: null,
      items: [
        {
          id: "fixture-user",
          type: "userMessage",
          content: [{ type: "text", text: "E2E_CSAQ34 browser question" }],
        },
      ],
    },
  ],
});
async function settleToolDetails(page) {
  const content = page.locator('[data-slot="collapsible-content"][data-state="open"]');
  const layouts = await content.evaluateAll(async (elements) => {
    await Promise.all(
      elements.flatMap((element) =>
        element.getAnimations({ subtree: true }).map((animation) => animation.finished),
      ),
    );
    return elements.map((element) => ({
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
    }));
  });
  assert.ok(layouts.length > 0);
  for (const layout of layouts)
    assert.ok(layout.height + 1 >= layout.scrollHeight, "expanded history must not be clipped");
}
function reset() {
  broker?.close();
  now = START;
  timers.clear();
  state = { thread: thread(), commands: [], responses: [] };
  broker = new InteractionBroker(
    {
      async request() {
        return {};
      },
      async respond(id, result) {
        state.responses.push({ id, result });
        const turn = state.thread.turns[0];
        turn.status = "completed";
        turn.completedAt = Math.floor(now / 1000);
        state.thread.status = { type: "idle" };
      },
      async respondError() {
        assert.fail("unexpected native response error");
      },
    },
    () => {},
    undefined,
    {
      now: () => now,
      schedule(callback, delay) {
        const id = ++timerId;
        timers.set(id, { at: now + delay, callback });
        return () => timers.delete(id);
      },
      onError: (error) => {
        throw error;
      },
      onQuestion(request, response) {
        observeNativeQuestion(state.thread, request.params, response);
      },
    },
  );
}
const readState = () => ({
  ...state,
  snapshot: projectThread(state.thread, {
    workspacePath: "/workspace",
    workspaceId: "/workspace",
    seq: now - START,
    revision: now - START,
    logEpoch: "fixture-epoch",
    interactions: broker.list("fixture-thread"),
  }),
});
async function advance(ms) {
  const target = now + ms;
  for (;;) {
    const next = [...timers]
      .filter(([, timer]) => timer.at <= target)
      .sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    now = next[1].at;
    timers.delete(next[0]);
    next[1].callback();
    await broker.whenSettled();
  }
  now = target;
}

before(async () => {
  const evidenceRoot = join(root, "packages/desktop/.e2e-artifacts");
  await mkdir(evidenceRoot, { recursive: true });
  artifacts = await mkdtemp(join(evidenceRoot, "codex-question-auto-resolution-"));
  reset();
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(artifacts, "vite-cache"),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "codex-question-auto-resolution-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (req.url?.startsWith("/fixture?")) {
              res.setHeader("Content-Type", "text/html");
              res.end(
                await vite.transformIndexHtml(
                  req.url,
                  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
                ),
              );
              return;
            }
            if (!req.url?.startsWith("/question-fixture/")) return next();
            try {
              if (req.url === "/question-fixture/review-done") {
                reviewDone.resolve();
                res.end("Review complete");
                return;
              }
              let result = readState();
              if (req.url === "/question-fixture/command") {
                let raw = "";
                for await (const chunk of req) raw += chunk;
                const command = JSON.parse(raw);
                state.commands.push(command);
                if (command.type === "snoozeInteractionAutoResolution")
                  await broker.snooze(command.sessionId, command.payload.interactionId);
                else if (command.type === "resolveInteraction")
                  await broker.resolve(
                    command.sessionId,
                    command.payload.interactionId,
                    command.payload.answer,
                  );
                else throw new Error("unexpected fixture command");
                result = {
                  commandId: command.commandId,
                  status: "accepted",
                  revisionAtDecision: 0,
                };
              }
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } catch (error) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: error.message }));
            }
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    executablePath: process.env.CHROME_EXECUTABLE_PATH ?? "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--remote-debugging-port=9339"],
  });
});
after(async () => {
  try {
    if (process.env.CODEZ_CSAQ34_BROWSER_REVIEW === "1") {
      // 可重复的 CLI 浏览器验收入口；仅 case-local broker，不连接真实用户的会话。
      reset();
      now = Date.now() - 241_000;
      const startedSeconds = Math.floor(now / 1000);
      state.thread.createdAt = startedSeconds;
      state.thread.updatedAt = startedSeconds;
      state.thread.turns[0].startedAt = startedSeconds;
      await broker.accept({
        id: "review-question",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "fixture-thread",
          turnId: "fixture-turn",
          itemId: "fixture-question",
          questions,
        },
      });
      console.log(`CSAQ34 browser review: ${origin}fixture?theme=dark&locale=en-US&mobile=true`);
      console.log(`CSAQ34 browser review artifacts: ${artifacts}`);
      await Promise.race([
        reviewDone.promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Browser review was not completed")), 180_000).unref(),
        ),
      ]);
      assert.equal(state.responses.length, 1, "review must submit one real form answer");
      assert.equal(
        state.commands.filter((command) => command.type === "snoozeInteractionAutoResolution")
          .length,
        1,
      );
      checks.push({
        case: "agent-browser",
        status: "passed",
        assertions: ["production-form", "single-snooze", "single-native-answer"],
        snapshot: readState().snapshot,
      });
    }
  } finally {
    broker?.close();
    await browser?.close();
    await server?.close();
    if (artifacts) {
      await writeFile(join(artifacts, "results.json"), JSON.stringify(checks, null, 2));
      console.log(`CSAQ34 browser artifacts: ${artifacts}`);
    }
  }
});

if (process.env.CODEZ_CSAQ34_BROWSER_REVIEW === "1")
  test("CSAQ34 interactive browser review fixture", () => assert.ok(browser));

for (const [width, theme, locale] of [
  [1200, "light", "zh-CN"],
  [1200, "dark", "en-US"],
  [390, "light", "en-US"],
  [390, "dark", "zh-CN"],
]) {
  test(`CSAQ34-07 ${width}px ${theme} ${locale}: fixed phases, first intent, drafts and history`, async () => {
    reset();
    const caseQuestions = [
      { ...questions[0], id: width === 390 ? "__proto__" : "constructor" },
      questions[1],
    ];
    await broker.accept({
      id: "native-question",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "fixture-thread",
        turnId: "fixture-turn",
        itemId: "fixture-question",
        questions: caseQuestions,
      },
    });
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      hasTouch: width === 390,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const check = { width, theme, locale, status: "running", assertions: [] };
    checks.push(check);
    const refresh = () => page.evaluate(() => window.questionFixtureRefresh());
    const advanceBoth = async (ms) => {
      await advance(ms);
      await page.clock.fastForward(ms);
      await refresh();
      // 胶囊中间进度用 CSS 动画，不逐秒 setState；窗口激活时按绝对 deadline 校准。
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    };
    try {
      await page.addInitScript(() => {
        window.questionWindowErrors = [];
        window.addEventListener("error", (event) =>
          window.questionWindowErrors.push(event.message),
        );
      });
      await page.clock.install({ time: new Date(START - 60_000) });
      await page.clock.pauseAt(new Date(START));
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return url.hostname === "127.0.0.1" || url.protocol === "data:"
          ? route.continue()
          : route.abort();
      });
      await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}&mobile=${width === 390}`, {
        waitUntil: "commit",
        timeout: 30_000,
      });
      await page.getByRole("dialog").waitFor({ timeout: 30_000 });
      assert.equal(
        JSON.parse(await page.getByTestId("fixture-preferences").textContent())
          .askUserQuestionAutoResolutionEnabled,
        true,
      );
      assert.equal(state.commands.length, 0, "mount/autofocus must not snooze");
      const badge = page.locator("[data-task-interaction-badge]");
      assert.equal(await badge.getAttribute("data-countdown-progress"), null);
      await advanceBoth(59_000);
      assert.equal(await badge.getAttribute("data-countdown-progress"), null);
      await advanceBoth(1_000);
      assert.equal(await badge.getAttribute("data-countdown-progress"), "1.000");
      await advanceBoth(120_000);
      assert.equal(await badge.getAttribute("data-countdown-progress"), "0.500");
      await advanceBoth(61_000);
      const countdown = page.getByTestId("codex-question-countdown");
      await countdown.waitFor();
      assert.match(await countdown.textContent(), /59/);
      const secret = page.getByLabel("E2E_CSAQ34 Private answer", { exact: true });
      await secret.focus();
      assert.equal(state.commands.length, 0, "programmatic focus is not intent");
      await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}-countdown.png`) });
      assert.equal(await secret.getAttribute("type"), "password");
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      check.assertions.push(
        "runtime-preference-preserved",
        "0-59-60-180s",
        "final-minute-59s",
        "focus-does-not-snooze",
        "responsive",
      );

      // All clicks/typing are real browser events; the backend broker, not the page, snoozes.
      if (width === 1200 && theme === "light") {
        await page.getByRole("dialog").hover();
        check.assertions.push("first-panel-hover");
      } else if (width === 1200) {
        await secret.fill("synthetic-private-answer");
        check.assertions.push("first-real-input");
      } else if (theme === "light") {
        await countdown.click();
        check.assertions.push("first-countdown-click");
      } else {
        const option = page.getByRole("button", { name: "Staging — Isolated", exact: true });
        await option.focus();
        assert.equal(state.commands.length, 0, "programmatic option focus is not intent");
        await option.press("Space");
        check.assertions.push("first-keyboard-selection");
      }
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="codex-question-countdown"]'),
      );
      assert.equal(broker.list("fixture-thread")[0].autoResolution.state, "snoozed");
      assert.equal(
        state.commands.filter((command) => command.type === "snoozeInteractionAutoResolution")
          .length,
        1,
      );
      await secret.fill("synthetic-private-answer");
      await page.getByRole("button", { name: "Staging — Isolated", exact: true }).click();
      await refresh();
      assert.equal(
        await secret.inputValue(),
        "synthetic-private-answer",
        "metadata must preserve drafts",
      );
      await advanceBoth(600_000);
      assert.equal(state.responses.length, 0);
      assert.equal(
        state.commands.filter((command) => command.type === "snoozeInteractionAutoResolution")
          .length,
        1,
      );
      assert.equal(
        await page.evaluate(() =>
          JSON.stringify({ ...localStorage }).includes("synthetic-private-answer"),
        ),
        false,
      );
      await page
        .getByRole("button", {
          name: locale === "en-US" ? "Submit answers" : "提交答案",
          exact: true,
        })
        .dblclick();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(state.responses.length, 1);
      assert.deepEqual(state.responses[0].result, {
        answers: Object.fromEntries([
          [caseQuestions[0].id, { answers: ["Staging"] }],
          ["secret", { answers: ["synthetic-private-answer"] }],
        ]),
      });
      await page
        .getByRole("button", {
          name: locale === "en-US" ? "Expand tool details" : "展开工具详情",
          exact: true,
        })
        .click();
      // 假时钟暂停了共享卡片的 rAF；推进渲染帧后取证，避免截到淡入或高度展开的中间态。
      await page.clock.runFor(500);
      await settleToolDetails(page);
      await page.getByText("Staging", { exact: true }).waitFor();
      await page.getByText("••••", { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => document.body.innerText.includes("synthetic-private-answer")),
        false,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({
        path: join(artifacts, `${width}-${theme}-${locale}-normal-history.png`),
        animations: "disabled",
      });
      await page
        .getByRole("button", {
          name: locale === "en-US" ? "Collapse tool details" : "收起工具详情",
          exact: true,
        })
        .click();
      check.assertions.push(
        "first-intent-one-snooze",
        "metadata-preserves-secret-draft",
        "snoozed-past-deadline",
        "single-native-answer",
        "no-persisted-secret",
        "native-normal-answer-history",
        "history-redacts-secret",
      );

      reset();
      await page.mouse.move(0, 0);
      await broker.accept({
        id: "auto-question",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "fixture-thread",
          turnId: "fixture-turn",
          itemId: "fixture-question",
          questions: caseQuestions,
        },
      });
      await page.clock.setSystemTime(new Date(START));
      await refresh();
      await page.getByRole("dialog").waitFor();
      await advanceBoth(241_000);
      assert.match(await page.getByTestId("codex-question-countdown").textContent(), /59/);
      await advanceBoth(58_000);
      assert.match(await page.getByTestId("codex-question-countdown").textContent(), /^1/);
      assert.equal(state.responses.length, 0);
      await advanceBoth(1_000);
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.clock.runFor(500);
      assert.deepEqual(state.responses, [{ id: "auto-question", result: { answers: {} } }]);
      await page
        .getByText(
          locale === "en-US" ? "No answer; continued automatically" : "未回答，已自动继续",
          { exact: true },
        )
        .waitFor();
      assert.equal(state.commands.length, 0, "no synthetic renderer answer or user message");
      await page
        .getByRole("button", {
          name: locale === "en-US" ? "Expand tool details" : "展开工具详情",
          exact: true,
        })
        .click();
      await page.clock.runFor(500);
      await settleToolDetails(page);
      assert.equal(
        await page
          .getByText(
            locale === "en-US" ? "No answer; continued automatically" : "未回答，已自动继续",
            { exact: true },
          )
          .count(),
        caseQuestions.length + 1,
        "empty Native answers cannot inherit values from a prototype-named question ID",
      );
      check.assertions.push(
        "last-second-1s",
        "empty-native-answer",
        "automatic-history-label",
        "no-fabricated-command",
        "prototype-question-ids-no-fabricated-answer",
      );
      assert.deepEqual(errors, []);
      const windowErrors = await page.evaluate(() => window.questionWindowErrors);
      check.layoutWarnings = windowErrors.filter((message) =>
        message.startsWith("ResizeObserver loop"),
      );
      assert.deepEqual(
        windowErrors.filter((message) => !message.startsWith("ResizeObserver loop")),
        [],
      );
      check.status = "passed";
      await page.screenshot({
        path: join(artifacts, `${width}-${theme}-${locale}-history.png`),
        animations: "disabled",
      });
    } catch (error) {
      check.status = "failed";
      check.error = error.message;
      await page
        .screenshot({ path: join(artifacts, `${width}-${theme}-${locale}-failure.png`) })
        .catch(() => {});
      throw error;
    } finally {
      await page.close();
    }
  });
}

test("CSAQ34 control: unchanged shared Ask card can emit layout notices without native pending or timers", async () => {
  reset();
  const seconds = Math.floor(Date.now() / 1000);
  state.thread.createdAt = seconds - 1;
  state.thread.updatedAt = seconds;
  state.thread.status = { type: "idle" };
  const turn = state.thread.turns[0];
  turn.startedAt = seconds - 1;
  turn.completedAt = seconds;
  turn.status = "completed";
  // 既有 Ask 展示路径：不使用 request_user_input 映射或 nested Native answers，也没有 broker 请求。
  turn.items.push({
    id: "baseline-ask",
    type: "dynamicToolCall",
    tool: "AskUserQuestion",
    arguments: { questions },
    status: "completed",
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({ answers: { target: "Staging", secret: "••••" } }),
      },
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  try {
    await page.addInitScript(() => {
      window.questionWindowErrors = [];
      window.addEventListener("error", (event) => window.questionWindowErrors.push(event.message));
    });
    await page.goto(`${origin}fixture?theme=light&locale=en-US`, { waitUntil: "commit" });
    await page.getByRole("button", { name: "Expand tool details", exact: true }).click();
    await page.getByText("Staging", { exact: true }).waitFor();
    await settleToolDetails(page);
    await page.screenshot({ path: join(artifacts, "shared-ask-control.png") });
    const windowErrors = await page.evaluate(() => window.questionWindowErrors);
    assert.deepEqual(
      windowErrors.filter((message) => !message.startsWith("ResizeObserver loop")),
      [],
    );
    assert.ok(
      windowErrors.some((message) => message.startsWith("ResizeObserver loop")),
      "control must reproduce the notice before attributing it to unchanged shared rendering",
    );
    assert.equal(timers.size, 0);
    assert.equal(state.commands.length, 0);
    checks.push({
      case: "shared-ask-control",
      status: "passed",
      layoutWarnings: windowErrors,
      assertions: ["unchanged-display-path", "no-native-pending-or-timer", "layout-notice-control"],
    });
  } finally {
    await page.close();
  }
});
