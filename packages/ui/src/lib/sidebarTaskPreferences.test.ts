import assert from "node:assert/strict";
import test from "node:test";
import {
  persistSidebarTaskPreferences,
  readSidebarTaskPreferences,
} from "@/lib/sidebarTaskPreferences.js";

function storageStub(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
  };
}

test("defaults are task-first (grouped) with no workspace filter (R4)", () => {
  const preferences = readSidebarTaskPreferences(storageStub());
  assert.equal(preferences.organizeBy, "grouped");
  assert.equal(preferences.sortBy, "updated");
  assert.equal(preferences.workspaceFilterKey, null);
});

test("workspace filter key round-trips through persistence", () => {
  const storage = storageStub();
  persistSidebarTaskPreferences(
    { organizeBy: "grouped", sortBy: "created", workspaceFilterKey: "remote-id:/repo" },
    storage,
  );
  const preferences = readSidebarTaskPreferences(storage);
  assert.equal(preferences.organizeBy, "grouped");
  assert.equal(preferences.sortBy, "created");
  assert.equal(preferences.workspaceFilterKey, "remote-id:/repo");
});

test("legacy payloads without workspaceFilterKey keep stored view choices and default filter to null", () => {
  const storage = storageStub(JSON.stringify({ organizeBy: "project", sortBy: "created" }));
  const preferences = readSidebarTaskPreferences(storage);
  // 已存储偏好的老用户保持原视图：R4 的默认翻转只影响没有存储偏好的用户。
  assert.equal(preferences.organizeBy, "project");
  assert.equal(preferences.sortBy, "created");
  assert.equal(preferences.workspaceFilterKey, null);
});

test("invalid or blank values fall back safely", () => {
  const storage = storageStub(
    JSON.stringify({ organizeBy: "bogus", sortBy: 1, workspaceFilterKey: "   " }),
  );
  const preferences = readSidebarTaskPreferences(storage);
  assert.equal(preferences.organizeBy, "grouped");
  assert.equal(preferences.sortBy, "updated");
  assert.equal(preferences.workspaceFilterKey, null);
  assert.deepEqual(readSidebarTaskPreferences(storageStub("not-json")).workspaceFilterKey, null);
});
