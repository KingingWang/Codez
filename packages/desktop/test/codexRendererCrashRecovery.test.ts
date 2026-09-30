import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
import {
  createRendererCrashRecovery,
  RECOVERABLE_RENDERER_CRASH_REASONS,
} from "../src/main/rendererCrashRecovery.js";

function makeHarness(maxAutoReloads?: number) {
  const reloads: number[] = [];
  const warnings: string[] = [];
  let quitting = false;
  let reloadable = true;
  // 策略测试用同步调度，聚焦预算与原因判定；延迟行为由单独用例覆盖。
  const recovery = createRendererCrashRecovery({
    reload: () => reloads.push(reloads.length + 1),
    canReload: () => reloadable,
    schedule: (task) => task(),
    isQuitting: () => quitting,
    logger: { warn: (message) => warnings.push(message) },
    ...(maxAutoReloads === undefined ? {} : { maxAutoReloads }),
  });
  return {
    recovery,
    reloads,
    warnings,
    setQuitting: (value: boolean) => (quitting = value),
    setReloadable: (value: boolean) => (reloadable = value),
  };
}

test("renderer crash recovery reloads recoverable reasons within budget", () => {
  const { recovery, reloads } = makeHarness();
  assert.deepEqual(
    [...RECOVERABLE_RENDERER_CRASH_REASONS].sort(),
    ["crashed", "killed", "launch-failed", "oom"].sort(),
  );
  assert.equal(recovery.handle({ reason: "crashed" }), "reloaded");
  assert.equal(recovery.handle({ reason: "oom" }), "reloaded");
  assert.deepEqual(reloads, [1, 2]);
  assert.equal(recovery.autoReloadCount, 2);
  // 预算耗尽后不再 reload，避免崩溃循环，并明确告警而不是静默。
  assert.equal(recovery.handle({ reason: "crashed" }), "budget-exhausted");
  assert.deepEqual(reloads, [1, 2]);
});

test("renderer crash recovery ignores clean exits and quitting app", () => {
  const { recovery, reloads, setQuitting } = makeHarness();
  assert.equal(recovery.handle({ reason: "clean-exit" }), "ignored");
  assert.equal(recovery.handle({ reason: "exit" }), "ignored");
  assert.equal(recovery.handle({}), "ignored");
  setQuitting(true);
  assert.equal(recovery.handle({ reason: "crashed" }), "ignored");
  assert.deepEqual(reloads, []);
  assert.equal(recovery.autoReloadCount, 0);
});

test("main-process crash recovery wiring avoids browser globals", async () => {
  // 回归：崩溃恢复曾误用 window.setTimeout；Electron 主进程是纯 Node 环境，
  // 该调用会在恢复路径抛 ReferenceError，使恢复完全失效。
  const index = await readFile(join(here, "..", "src", "main", "index.ts"), "utf8");
  const start = index.indexOf("createRendererCrashRecovery({");
  assert.notEqual(start, -1);
  const end = index.indexOf("isQuitting:", start);
  assert.notEqual(end, -1);
  const wiring = index
    .slice(start, end)
    // 去掉注释后再断言：注释里可能以散文形式提到浏览器全局，不能作为违规证据。
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/u, ""))
    .join("\n");
  assert.equal(wiring.includes("window."), false);
  assert.match(wiring, /win\.webContents\.reload\(\)/u);
});

test("crash recovery uses the registered workspace window boundary, not all application windows", async () => {
  const index = await readFile(join(here, "..", "src", "main", "index.ts"), "utf8");
  const start = index.indexOf('win.webContents.on("render-process-gone"');
  const end = index.indexOf("rendererCrashRecovery.handle(details);", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const wiring = index.slice(start, end);
  // About、更新和资源管理器也属于 application windows，但不是 workspace renderer。
  // 复用 createWindow 在首次加载前登记的 WebContents 身份，不依赖 Host 是否已启动。
  assert.match(
    wiring,
    /if \(!isMainApplicationWindowWebContents\(windowWebContentsId\)\) return;/u,
  );
  assert.doesNotMatch(wiring, /getMainApplicationWindows\(\)|windowHostProcessMap\./u);
});

test("crash recovery defers reload and re-checks liveness and quit state", () => {
  const scheduled: Array<() => void> = [];
  const reloads: string[] = [];
  const warnings: string[] = [];
  let quitting = false;
  let reloadable = true;
  const recovery = createRendererCrashRecovery({
    reload: () => reloads.push("reloaded"),
    canReload: () => reloadable,
    schedule: (task) => scheduled.push(task),
    reloadDelayMs: 1000,
    maxAutoReloads: 4,
    isQuitting: () => quitting,
    logger: { warn: (message) => warnings.push(message) },
  });
  // handle 只调度，不立即 reload：避免在崩溃回调里触碰尚未收尾的 WebContents。
  assert.equal(recovery.handle({ reason: "crashed" }), "reloaded");
  assert.deepEqual(reloads, []);
  assert.equal(scheduled.length, 1);
  scheduled[0]!();
  assert.deepEqual(reloads, ["reloaded"]);

  // 延迟到期时窗口已消失：只告警，不 reload。
  assert.equal(recovery.handle({ reason: "oom" }), "reloaded");
  reloadable = false;
  scheduled[1]!();
  assert.deepEqual(reloads, ["reloaded"]);
  assert.ok(warnings.some((line) => line.includes("deferred reload skipped")));

  // 延迟到期时应用正在退出：静默放弃，不 reload。
  assert.equal(recovery.handle({ reason: "killed" }), "reloaded");
  reloadable = true;
  quitting = true;
  const before = reloads.length;
  scheduled[2]!();
  assert.equal(reloads.length, before);
});
