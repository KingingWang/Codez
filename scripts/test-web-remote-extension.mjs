import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createWebRemoteExtensionManifest,
  createWebRemoteExtensionRules,
  extractInlineBootstrapScriptForExtension,
  stageWebRemoteExtensionFromDist,
} from "./build-web-remote-extension.mjs";

test("Manifest V3 规则覆盖 Origin 重写、GitHub Pages 扫码入口接管与 OAuth 回调重定向", () => {
  const rules = createWebRemoteExtensionRules();
  assert.equal(rules.length, 3);

  const originRule = rules.find((r) => r.id === 1);
  assert.equal(originRule.action.type, "modifyHeaders");
  assert.deepEqual(originRule.action.requestHeaders, [
    { header: "Origin", operation: "set", value: "https://zcode.z.ai" },
  ]);
  assert.ok(originRule.condition.resourceTypes.includes("websocket"));
  assert.ok(originRule.condition.resourceTypes.includes("xmlhttprequest"));

  const pagesRedirectRule = rules.find((r) => r.id === 2);
  const pagesRegex = new RegExp(pagesRedirectRule.condition.regexFilter, "u");
  assert.ok(
    pagesRegex.test("https://kingingwang.github.io/Codez/remote/v4/?sid=abc#e2ee=v1&k=xyz"),
  );
  assert.ok(pagesRegex.test("https://kingingwang.github.io/Codez/remote/v4"));
  assert.ok(!pagesRegex.test("https://kingingwang.github.io/Codez/other"));

  const oauthRedirectRule = rules.find((r) => r.id === 3);
  const oauthRegex = new RegExp(oauthRedirectRule.condition.regexFilter, "u");
  assert.ok(oauthRegex.test("https://zcode.z.ai/remote/v4?code=abc&state=123"));
  assert.ok(oauthRegex.test("https://zcode.z.ai/remote/v4/?sid=d1&authCode=abc&state=123"));
  assert.ok(!oauthRegex.test("https://zcode.z.ai/remote/v4?sid=d1"));
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
    assert.ok((await stat(join(outDir, "rules.json"))).isFile());
    assert.ok((await stat(join(outDir, "icons/128x128.png"))).isFile());
    await assert.rejects(stat(join(outDir, "assets/index.js.map")));

    const zipStat = await stat(zipPath);
    assert.ok(zipStat.isFile() && zipStat.size > 0);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
