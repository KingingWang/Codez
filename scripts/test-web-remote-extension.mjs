import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createWebRemoteExtensionBackgroundScript,
  createWebRemoteExtensionContentScript,
  createWebRemoteExtensionManifest,
  createWebRemoteExtensionRules,
  extractInlineBootstrapScriptForExtension,
  stageWebRemoteExtensionFromDist,
} from "./build-web-remote-extension.mjs";

test("Manifest V3 规则仅改写 Origin，页面级重定向交给 content script 与 background 保留 query/hash", () => {
  const rules = createWebRemoteExtensionRules();
  assert.equal(rules.length, 1);

  const originRule = rules.find((r) => r.id === 1);
  assert.equal(originRule.action.type, "modifyHeaders");
  assert.deepEqual(originRule.action.requestHeaders, [
    { header: "Origin", operation: "set", value: "https://zcode.z.ai" },
  ]);
  assert.ok(originRule.condition.resourceTypes.includes("websocket"));
  assert.ok(originRule.condition.resourceTypes.includes("xmlhttprequest"));

  const contentScript = createWebRemoteExtensionContentScript();
  assert.ok(contentScript.includes("setAttribute('data-codez-browser-extension', 'true')"));
  assert.ok(contentScript.includes("codez-redirect-to-extension"));
  assert.ok(contentScript.includes("loc.search"));
  assert.ok(contentScript.includes("loc.hash"));

  const backgroundScript = createWebRemoteExtensionBackgroundScript();
  assert.ok(backgroundScript.includes("codez-redirect-to-extension"));
  assert.ok(backgroundScript.includes("resolveExtensionRedirectTarget"));
  assert.ok(backgroundScript.includes("injectExtensionMarkerAndRedirectExistingTabs"));
});

test("stageWebRemoteExtensionFromDist 提取内联脚本并生成完整扩展目录与 zip 包", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "codez-web-ext-test-"));
  try {
    const distDir = join(workDir, "dist");
    const outDir = join(workDir, "dist-extension");
    const zipPath = join(workDir, "codez-web-remote-extension.zip");
    await mkdir(join(distDir, "assets"), { recursive: true });

    const rawIndexHtml = await readFile(new URL("../packages/web/index.html", import.meta.url), "utf8");
    const simulatedBuiltHtml = rawIndexHtml.replace(
      '<script type="module" src="/src/main.tsx"></script>',
      '<script type="module" crossorigin src="./assets/index.js"></script><link rel="stylesheet" crossorigin href="./assets/index.css">',
    );
    await writeFile(join(distDir, "index.html"), simulatedBuiltHtml, "utf8");
    await writeFile(join(distDir, "assets/index.js"), "console.log('ok');", "utf8");
    await writeFile(join(distDir, "assets/index.js.map"), "{}", "utf8");
    await writeFile(join(distDir, "assets/index.css"), "body{}", "utf8");

    const extracted = extractInlineBootstrapScriptForExtension(simulatedBuiltHtml);
    assert.ok(!extracted.html.includes("const STORAGE_KEY ="));
    assert.ok(extracted.html.includes('<script src="./bootstrap-theme.js"></script>'));
    assert.ok(extracted.html.includes('data-codez-browser-extension="true"'));

    await stageWebRemoteExtensionFromDist({
      distDir,
      outDir,
      zipPath,
      version: "3.16.2-beta.1",
    });

    const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.version, "3.16.2");
    assert.deepEqual(manifest, createWebRemoteExtensionManifest("3.16.2-beta.1"));

    assert.ok((await stat(join(outDir, "bootstrap-theme.js"))).isFile());
    assert.ok((await stat(join(outDir, "background.js"))).isFile());
    assert.ok((await stat(join(outDir, "redirect-content.js"))).isFile());
    assert.ok((await stat(join(outDir, "rules.json"))).isFile());
    assert.ok((await stat(join(outDir, "icons/128x128.png"))).isFile());
    await assert.rejects(stat(join(outDir, "assets/index.js.map")));

    const zipStat = await stat(zipPath);
    assert.ok(zipStat.isFile() && zipStat.size > 0);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
