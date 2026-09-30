import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, "..", "src", "renderer", "index.html");
const mainPath = join(here, "..", "src", "renderer", "src", "main.tsx");

test("renderer bootstrap shell never treats splash removal as React readiness", async () => {
  const html = await readFile(htmlPath, "utf8");
  // 回归：3s 兜底曾直接调用 markReactReady，把"启动壳已移除"伪装成 React 已挂载，
  // 导致模块图加载失败时留下永久空白窗口且没有任何可操作信息。
  assert.equal(html.includes("window.setTimeout(markReactReady, 3000)"), false);
  const inline = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(
    (match) => match[1],
  );
  assert.equal(inline.length, 1);
  const script = inline[0]!;
  // reactReady 只能由 markReactReady 置位，且 markReactReady 只绑定真实 ready 事件。
  assert.match(script, /const markReactReady = \(\) => \{\s*reactReady = true;/u);
  assert.match(script, /addEventListener\("codez-react-startup-ready", markReactReady/u);
  assert.equal(/setTimeout\(markReactReady/u.test(script), false);
});

test("renderer bootstrap watchdog keeps module-graph failure visible and recoverable", async () => {
  const html = await readFile(htmlPath, "utf8");
  const inline = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(
    (match) => match[1],
  );
  const script = inline[0]!;
  // 看门狗必须无依赖（内联、无 import），模块图损坏时仍然可运行。
  assert.equal(/import\s/u.test(script), false);
  assert.match(script, /checkBootstrapFailure/u);
  assert.match(script, /codez-bootstrap-failure/u);
  // 失败证据：脚本/样式资源错误与动态导入拒绝。
  assert.match(script, /tagName === "SCRIPT"/u);
  assert.match(script, /dynamically imported module/u);
  // 先自动重试一次，再展示可操作错误面（含 Reload 动作）。
  assert.match(script, /codez-bootstrap-auto-retried/u);
  assert.match(script, /window\.location\.reload\(\)/u);
  // React 已挂载或更新状态窗口不得触发看门狗。
  assert.match(
    script,
    /if \(reactReady \|\| bootstrapFailureUiShown \|\| isUpdateStatusWindow\) return;/u,
  );
});

test("renderer ready event name stays coupled between shell and entry", async () => {
  const html = await readFile(htmlPath, "utf8");
  const main = await readFile(mainPath, "utf8");
  const eventName = "codez-react-startup-ready";
  assert.match(html, new RegExp(`addEventListener\\("${eventName}", markReactReady`, "u"));
  assert.match(main, new RegExp(`new Event\\("${eventName}"\\)`, "u"));
});
