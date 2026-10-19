import assert from "node:assert/strict";
import test from "node:test";
import {
  readCodexFullAccessAcknowledged,
  writeCodexFullAccessAcknowledged,
} from "./codexFullAccessAcknowledgement.js";

const STORAGE_KEY = "codez.codex.fullAccessAcknowledged.v1";

// 模块在调用时才读取 window.localStorage，测试只需在调用期间放置 stub。
function stubWindowLocalStorage(store: Map<string, string> | "throw") {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem(key: string) {
        if (store === "throw") throw new Error("storage disabled");
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        if (store === "throw") throw new Error("storage disabled");
        store.set(key, value);
      },
    },
  };
  return () => {
    (globalThis as { window?: unknown }).window = previous;
  };
}

test("full access acknowledgement persists and reads back", () => {
  const store = new Map<string, string>();
  const restore = stubWindowLocalStorage(store);
  try {
    assert.equal(readCodexFullAccessAcknowledged(), false);
    writeCodexFullAccessAcknowledged();
    assert.equal(store.get(STORAGE_KEY), "1");
    assert.equal(readCodexFullAccessAcknowledged(), true);
  } finally {
    restore();
  }
});

test("storage failures fail closed to unacknowledged without throwing", () => {
  const restore = stubWindowLocalStorage("throw");
  try {
    // 读失败按未确认处理（宁可多弹一次确认，不能跳过放权警告）。
    assert.equal(readCodexFullAccessAcknowledged(), false);
    // 写失败不抛出（不阻断本次切换）。
    writeCodexFullAccessAcknowledged();
  } finally {
    restore();
  }
});
