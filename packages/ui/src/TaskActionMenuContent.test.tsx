import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskActionMenuContent } from "./TaskActionMenuContent.js";

const labels = new Map([
  ["taskList.pin", "Pin"],
  ["taskList.rename", "Rename"],
  ["taskList.archive", "Archive"],
  ["taskList.markAsUnread", "Mark as unread"],
  ["appHeader.copyPath", "Copy path"],
  ["appHeader.copyTaskPath", "Copy task path"],
  ["appHeader.copyLogPath", "Copy log path"],
]);

function renderMenu(
  taskSessionFile: { loading: boolean; path: string | null; exists: boolean },
  taskNativeSessionLogFile: { loading: boolean; path: string | null; exists: boolean },
) {
  return renderToStaticMarkup(
    <TaskActionMenuContent
      intl={{ formatMessage: ({ id }) => labels.get(id) ?? id }}
      isPinned={false}
      fileManagerLabel="Open in file manager"
      taskSessionFile={taskSessionFile}
      activeSessionId="task-1"
      taskNativeSessionLogFile={taskNativeSessionLogFile}
      Item={({ disabled, children }) => (
        <div data-disabled={disabled ? "true" : "false"}>{children}</div>
      )}
      Separator={() => null}
      onTogglePinTask={() => {}}
      onStartRenameTask={() => {}}
      onArchiveTask={() => {}}
      onMarkTaskAsUnread={() => {}}
      onOpenTaskPathInFileManager={() => {}}
      onCopyWorkspacePath={() => {}}
      onCopyTaskPath={() => {}}
      onCopyTaskLogPath={() => {}}
    />,
  );
}

function taskPathItem(html: string) {
  const match = html.match(/<div data-disabled="([^"]+)">Copy task path<\/div>/);
  assert.ok(match, "Copy task path item should render");
  return match[1];
}

function logPathItem(html: string) {
  const match = html.match(/<div data-disabled="([^"]+)">Copy log path<\/div>/);
  assert.ok(match, "Copy log path item should render");
  return match[1];
}

test("task diagnostics copy is enabled only after an existing path resolves", () => {
  const html = renderMenu(
    { loading: false, path: "/tasks/session.jsonl", exists: true },
    { loading: false, path: "/logs/native.log", exists: true },
  );
  assert.equal(taskPathItem(html), "false");
  assert.equal(logPathItem(html), "false");
});

test("unknown, loading, and proven-missing task diagnostics paths stay disabled", () => {
  const states = [
    { loading: true, path: "/tasks/session.jsonl", exists: true },
    { loading: false, path: null, exists: false },
    { loading: false, path: "/missing/session.jsonl", exists: false },
  ] as const;

  for (const state of states) {
    const html = renderMenu(state, state);
    assert.equal(taskPathItem(html), "true");
    assert.equal(logPathItem(html), "true");
  }
});

test("grouped task context menu applies the same existence guard to both diagnostics paths", async () => {
  const source = await readFile(
    new URL("./workspace-grouped-tasks/task-context-menu-content.tsx", import.meta.url),
    "utf8",
  );
  const sessionGuard = source.match(
    /disabled=\{\s*taskSessionFile\.loading\s*\|\|\s*!taskSessionFile\.path\s*\|\|\s*!taskSessionFile\.exists\s*\}/,
  );
  const logGuard = source.match(
    /disabled=\{\s*taskNativeSessionLogFile\.loading\s*\|\|\s*!taskNativeSessionLogFile\.path\s*\|\|\s*!taskNativeSessionLogFile\.exists\s*\}/,
  );

  assert.ok(sessionGuard, "grouped Copy task path must include exists in its disabled expression");
  assert.ok(logGuard, "grouped Copy log path must include exists in its disabled expression");
});
