import assert from "node:assert/strict";
import test from "node:test";

import {
  RewindNoticeStore,
  formatRewindNotice,
  relativizeRewindNoticePath,
} from "../src/rewind-notice.js";

test("rewind notice store: record/peek/clear 语义", () => {
  const store = new RewindNoticeStore();
  const entryA = {
    turnId: "turn-a",
    files: [{ path: "src/a.ts", additions: 10, deletions: 2 }],
  };
  const entryB = {
    turnId: "turn-b",
    files: [{ path: "src/b.ts", additions: 0, deletions: 5 }],
  };

  assert.equal(store.peek("s1"), undefined);
  store.record("s1", entryA);
  store.record("s1", entryB);
  // 同一 turn 重放登记不得重复。
  store.record("s1", entryA);
  // peek 不消费。
  assert.equal(store.peek("s1")?.length, 2);
  assert.equal(store.peek("s1")?.length, 2);

  const consumed = store.peek("s1")!;
  // 读取后又 record 的新条目必须保留。
  store.record("s1", { turnId: "turn-c", files: [] });
  store.clear("s1", consumed);
  assert.deepEqual(
    store.peek("s1")?.map((entry) => entry.turnId),
    ["turn-c"],
  );
  store.clear("s1", store.peek("s1")!);
  assert.equal(store.peek("s1"), undefined);

  // session 隔离。
  store.record("s1", entryA);
  store.record("s2", entryB);
  assert.equal(store.peek("s2")?.length, 1);
  assert.equal(store.peek("s1")?.length, 1);
});

test("formatRewindNotice 汇总多轮撤销并声明恢复事实", () => {
  const text = formatRewindNotice([
    {
      turnId: "turn-a",
      files: [
        { path: "src/a.ts", additions: 10, deletions: 2 },
        { path: "src/b.ts", additions: 3, deletions: 0 },
      ],
    },
    { turnId: "turn-b", files: [{ path: "src/c.ts", additions: 0, deletions: 7 }] },
  ]);
  assert.ok(text.startsWith("[User action: file changes reverted]"));
  assert.ok(text.includes("2 earlier turns"));
  assert.ok(text.includes("- `src/a.ts` (+10/-2)"));
  assert.ok(text.includes("- `src/b.ts` (+3/-0)"));
  assert.ok(text.includes("- `src/c.ts` (+0/-7)"));
  assert.ok(text.includes("restored to the state before those edits"));

  const single = formatRewindNotice([
    { turnId: "turn-a", files: [{ path: "a.ts", additions: 1, deletions: 0 }] },
  ]);
  assert.ok(single.includes("1 earlier turn of"));
});

test("relativizeRewindNoticePath 相对化工作区内绝对路径", () => {
  assert.equal(relativizeRewindNoticePath("/workspace", "/workspace/src/a.ts"), "src/a.ts");
  // 越出工作区/同前缀兄弟目录：保留原路径（仅展示用途）。
  assert.equal(
    relativizeRewindNoticePath("/workspace", "/workspace-other/a.ts"),
    "/workspace-other/a.ts",
  );
  assert.equal(relativizeRewindNoticePath("/workspace", "src/a.ts"), "src/a.ts");
});
