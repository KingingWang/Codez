import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeNoticeStore } from "../src/runtime-notices.js";

test("workspace and thread notices keep their scope and ignore malformed events", () => {
  const store = new RuntimeNoticeStore(() => 1_700_000_000_000);
  assert.deepEqual(
    store.apply({ method: "warning", params: { threadId: null, message: "global" } }),
    { scope: "workspace" },
  );
  store.apply({
    method: "configWarning",
    params: {
      summary: "config summary",
      details: "config details",
      path: "/private/config.toml",
      range: { start: { line: 2, column: 3 }, end: { line: 4, column: 5 } },
    },
  });
  store.apply({
    method: "deprecationNotice",
    params: { summary: "deprecated", details: null },
  });
  store.apply({ method: "warning", params: { threadId: "t1", message: "targeted" } });
  store.apply({ method: "guardianWarning", params: { threadId: "t1", message: "guardian" } });
  for (const params of [
    { threadId: "t1" },
    { threadId: 1, message: "bad id" },
    { threadId: "t1", message: "   " },
  ]) {
    assert.equal(store.apply({ method: "warning", params }), undefined);
  }
  assert.equal(
    store.apply({ method: "guardianWarning", params: { message: "missing" } }),
    undefined,
  );
  assert.equal(store.apply({ method: "futureWarning", params: { message: "ignored" } }), undefined);

  const targeted = store.list("t1");
  assert.deepEqual(
    targeted.map((notice) => notice.kind),
    ["warning", "configWarning", "deprecationNotice", "warning", "guardianWarning"],
  );
  assert.equal(targeted[0]?.at, 1_700_000_000_000);
  assert.match(targeted[1]?.detail ?? "", /config details/);
  assert.match(targeted[1]?.detail ?? "", /config\.toml/);
  assert.match(targeted[1]?.detail ?? "", /2:3/);
  assert.deepEqual(
    store.list("t2").map((notice) => notice.message),
    ["global", "config summary", "deprecated"],
  );
});

test("consecutive duplicates are idempotent and auth completion replaces the active phase", () => {
  let now = 100;
  const store = new RuntimeNoticeStore(() => now++);
  const started = {
    threadId: "t1",
    turnId: "turn-1",
    provider: "openai",
    message: "recovering",
  };
  assert.deepEqual(store.apply({ method: "modelProvider/authRecoveryStarted", params: started }), {
    scope: "thread",
    threadId: "t1",
  });
  const active = store.list("t1")[0];
  assert.equal(active?.phase, "started");
  assert.equal(active?.turnId, "turn-1");
  assert.equal(active?.provider, "openai");
  assert.equal(
    store.apply({ method: "modelProvider/authRecoveryStarted", params: started }),
    undefined,
  );
  store.apply({ method: "warning", params: { threadId: null, message: "same" } });
  assert.equal(
    store.apply({ method: "warning", params: { threadId: null, message: "same" } }),
    undefined,
  );

  store.apply({
    method: "modelProvider/authRecoveryCompleted",
    params: { ...started, message: "recovered" },
  });
  const notices = store.list("t1");
  assert.equal(notices.filter((notice) => notice.kind === "authRecovery").length, 1);
  assert.equal(notices.at(-1)?.phase, "completed");
  assert.equal(notices.at(-1)?.message, "recovered");
  assert.equal(notices.at(-1)?.id, active?.id);

  store.apply({ method: "thread/deleted", params: { threadId: "t1" } });
  assert.deepEqual(
    store.list("t1").map((notice) => notice.kind),
    ["warning"],
  );
});

test("notice text and caches are bounded", () => {
  const store = new RuntimeNoticeStore();
  for (let index = 0; index < 10; index += 1) {
    store.apply({ method: "warning", params: { threadId: null, message: `global-${index}` } });
    store.apply({ method: "warning", params: { threadId: "t1", message: `local-${index}` } });
  }
  const notices = store.list("t1");
  assert.equal(notices.length, 16);
  assert.deepEqual(
    notices.slice(0, 8).map((notice) => notice.message),
    [
      "global-2",
      "global-3",
      "global-4",
      "global-5",
      "global-6",
      "global-7",
      "global-8",
      "global-9",
    ],
  );
  assert.equal(notices[8]?.message, "local-2");
  assert.equal(notices.at(-1)?.message, "local-9");

  store.apply({
    method: "warning",
    params: { threadId: null, message: "x".repeat(5_000), details: "ignored" },
  });
  assert.equal(store.list("t2").at(-1)?.message.length, 4_096);
  store.apply({
    method: "deprecationNotice",
    params: { summary: "bounded", details: "d".repeat(20_000) },
  });
  assert.equal(store.list("t2").at(-1)?.detail?.length, 16_384);

  for (let index = 0; index < 65; index += 1) {
    store.apply({ method: "warning", params: { threadId: `thread-${index}`, message: "notice" } });
  }
  assert.equal(
    store.list("thread-0").some((notice) => notice.message === "notice"),
    false,
  );
  assert.equal(store.list("thread-64").at(-1)?.message, "notice");
});
