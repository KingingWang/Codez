#!/usr/bin/env node

import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommand } from "./spawn-command.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDistDir = join(repoRoot, "packages/web/dist");
const defaultAssetsDir = join(repoRoot, "packages/android/app/src/main/assets/remote/v4");

export async function stageAndroidWebAssetsFromDist({
  distDir = defaultDistDir,
  assetsDir = defaultAssetsDir,
} = {}) {
  const indexHtml = join(distDir, "index.html");
  await stat(indexHtml);

  await rm(assetsDir, { recursive: true, force: true });
  await mkdir(assetsDir, { recursive: true });
  await cp(distDir, assetsDir, {
    recursive: true,
    filter: (src) => !src.endsWith(".map"),
  });

  return { distDir, assetsDir };
}

export async function buildAndStageAndroidWebAssets({
  distDir = defaultDistDir,
  assetsDir = defaultAssetsDir,
  codezEnv = process.env.CODEZ_ENV || "production",
} = {}) {
  runCommand(
    "pnpm",
    ["--filter", "@codez/web", "exec", "vite", "build", "--base=/Codez/remote/v4/"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEZ_ENV: codezEnv,
      },
    },
  );
  return stageAndroidWebAssetsFromDist({ distDir, assetsDir });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const skipBuild = process.argv.includes("--from-dist");
  const result = skipBuild
    ? await stageAndroidWebAssetsFromDist()
    : await buildAndStageAndroidWebAssets();
  console.log(`[android-web-assets] Staged Web remote bundle to ${result.assetsDir}`);
}
