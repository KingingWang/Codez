import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stageAndroidWebAssetsFromDist } from "./stage-android-web-assets.mjs";

test("stageAndroidWebAssetsFromDist 拷贝 Web 远控构建产物到 Android assets 并排除 .map 文件", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "codez-android-assets-test-"));
  try {
    const distDir = join(workDir, "dist");
    const assetsDir = join(workDir, "android-assets/remote/v4");
    await mkdir(join(distDir, "assets"), { recursive: true });
    await writeFile(
      join(distDir, "index.html"),
      '<!doctype html><script type="module" src="/Codez/remote/v4/assets/index.js"></script>',
      "utf8",
    );
    await writeFile(join(distDir, "assets/index.js"), "console.log('android');", "utf8");
    await writeFile(join(distDir, "assets/index.js.map"), "{}", "utf8");

    await stageAndroidWebAssetsFromDist({ distDir, assetsDir });

    const stagedHtml = await readFile(join(assetsDir, "index.html"), "utf8");
    assert.ok(stagedHtml.includes("/Codez/remote/v4/assets/index.js"));
    assert.ok((await stat(join(assetsDir, "assets/index.js"))).isFile());
    await assert.rejects(stat(join(assetsDir, "assets/index.js.map")));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
