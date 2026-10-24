#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommand } from "./spawn-command.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "packages/desktop/package.json"));

/**
 * 生成 Manifest V3 的 declarativeNetRequest 规则集：
 * 1. 将发往 https://zcode.z.ai/api/v1/*（含 HTTP 与 wss:// WebSocket）的请求头 Origin 设为 https://zcode.z.ai，
 *    解决本地扩展或 fork 页面连接云端 relay 时的 403 拦截；
 * 2. 将扫码/打开的 https://kingingwang.github.io/Codez/remote/v4/* 链接重定向到本地扩展页面 /index.html，
 *    完整保留 query（sid/mid/name/app_version）与 hash（#e2ee=v1&k=...），不从远端下载可执行脚本；
 * 3. 将智谱 OAuth 登录完成回跳的 https://zcode.z.ai/remote/v4?code|authCode|error=...&state=...
 *    重定向到本地扩展页面 /index.html 完成 Token 兑换与 E2EE 密钥恢复。
 */
export function createWebRemoteExtensionRules() {
  return [
    {
      id: 1,
      priority: 100,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          {
            header: "Origin",
            operation: "set",
            value: "https://zcode.z.ai",
          },
        ],
      },
      condition: {
        urlFilter: "||zcode.z.ai/api/v1/*",
        resourceTypes: ["xmlhttprequest", "websocket", "other"],
      },
    },
    {
      id: 2,
      priority: 90,
      action: {
        type: "redirect",
        redirect: {
          extensionPath: "/index.html",
        },
      },
      condition: {
        regexFilter: "^https://kingingwang\\.github\\.io/Codez/remote/v4/?(?:[?#].*)?$",
        resourceTypes: ["main_frame"],
      },
    },
    {
      id: 3,
      priority: 90,
      action: {
        type: "redirect",
        redirect: {
          extensionPath: "/index.html",
        },
      },
      condition: {
        regexFilter:
          "^https://zcode\\.z\\.ai/remote/v4/?\\?(?:[^#]*&)?(?:code|authCode|error)=[^#]*$",
        resourceTypes: ["main_frame"],
      },
    },
  ];
}

export function createWebRemoteExtensionManifest(version) {
  const normalizedVersion = String(version || "1.0.0").replace(/[-+].*$/u, "");
  return {
    manifest_version: 3,
    name: "Codez Remote Control",
    version: normalizedVersion,
    description:
      "End-to-end encrypted browser extension for Codez desktop remote control (scan QR or select device).",
    icons: {
      16: "icons/16x16.png",
      32: "icons/32x32.png",
      48: "icons/48x48.png",
      128: "icons/128x128.png",
    },
    action: {
      default_title: "Codez Remote Control",
      default_icon: {
        16: "icons/16x16.png",
        32: "icons/32x32.png",
        48: "icons/48x48.png",
        128: "icons/128x128.png",
      },
    },
    background: {
      service_worker: "background.js",
      type: "module",
    },
    permissions: ["declarativeNetRequest", "declarativeNetRequestWithHostAccess", "tabs"],
    host_permissions: [
      "https://zcode.z.ai/*",
      "wss://zcode.z.ai/*",
      "https://kingingwang.github.io/*",
    ],
    declarative_net_request: {
      rule_resources: [
        {
          id: "codez_remote_rules",
          enabled: true,
          path: "rules.json",
        },
      ],
    },
    web_accessible_resources: [
      {
        resources: ["index.html", "assets/*", "icons/*"],
        matches: ["https://kingingwang.github.io/*", "https://zcode.z.ai/*"],
      },
    ],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' https://zcode.z.ai wss://zcode.z.ai https://chat.z.ai https://bigmodel.cn https://open.bigmodel.cn;",
    },
    browser_specific_settings: {
      gecko: {
        id: "remote-control@codez.app",
        strict_min_version: "113.0",
      },
    },
  };
}

export function createWebRemoteExtensionBackgroundScript() {
  return [
    "// 点击浏览器工具栏扩展图标时，打开或聚焦本地远控主页面。",
    "const api = globalThis.chrome ?? globalThis.browser;",
    "",
    "function resolveExtensionRedirectTarget(rawUrl) {",
    "  if (!rawUrl || !api?.runtime?.getURL) return null;",
    "  let parsed;",
    "  try {",
    "    parsed = new URL(rawUrl);",
    "  } catch {",
    "    return null;",
    "  }",
    "  const normalizedPath = parsed.pathname.replace(/\\/+$/u, '');",
    "  const isForkRemotePage =",
    "    parsed.protocol === 'https:' &&",
    "    parsed.hostname === 'kingingwang.github.io' &&",
    "    normalizedPath === '/Codez/remote/v4';",
    "  const isOfficialOAuthCallback =",
    "    parsed.protocol === 'https:' &&",
    "    parsed.hostname === 'zcode.z.ai' &&",
    "    normalizedPath === '/remote/v4' &&",
    "    parsed.searchParams.has('state') &&",
    "    (parsed.searchParams.has('code') ||",
    "      parsed.searchParams.has('authCode') ||",
    "      parsed.searchParams.has('error'));",
    "  if (!isForkRemotePage && !isOfficialOAuthCallback) return null;",
    "  const base = new URL(api.runtime.getURL('index.html'));",
    "  base.search = parsed.search;",
    "  base.hash = parsed.hash;",
    "  return base.toString();",
    "}",
    "",
    "if (api?.tabs?.onUpdated) {",
    "  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {",
    "    const candidateUrl = changeInfo.url || tab?.pendingUrl || tab?.url;",
    "    const redirectUrl = resolveExtensionRedirectTarget(candidateUrl);",
    "    if (redirectUrl) {",
    "      void api.tabs.update(tabId, { url: redirectUrl });",
    "    }",
    "  });",
    "}",
    "",
    "if (api?.action?.onClicked) {",
    "  api.action.onClicked.addListener(async () => {",
    "    const targetUrl = api.runtime.getURL('index.html');",
    "    try {",
    "      const existingTabs = await api.tabs.query({ url: `${targetUrl}*` });",
    "      const firstTab = Array.isArray(existingTabs) ? existingTabs[0] : undefined;",
    "      if (firstTab?.id !== undefined) {",
    "        await api.tabs.update(firstTab.id, { active: true });",
    "        if (firstTab.windowId !== undefined && api.windows?.update) {",
    "          await api.windows.update(firstTab.windowId, { focused: true });",
    "        }",
    "        return;",
    "      }",
    "    } catch {",
    "      // fallback to creating a new tab",
    "    }",
    "    await api.tabs.create({ url: targetUrl });",
    "  });",
    "}",
    "",
  ].join("\n");
}

/**
 * 提取 index.html 中的内联 <script> 到独立文件 bootstrap-theme.js，
 * 以满足 Manifest V3 默认禁止 extension_pages 内联脚本的 CSP 要求。
 */
export function extractInlineBootstrapScriptForExtension(html) {
  const inlineScriptRegex = /<script>\s*(\(\(\)\s*=>\s*\{[\s\S]*?\}\)\(\);)\s*<\/script>/u;
  const match = html.match(inlineScriptRegex);
  if (!match) {
    throw new Error("Could not find inline bootstrap theme script in index.html");
  }
  const scriptContent = `${match[1]}\n`;
  const transformedHtml = html
    .replace('<html lang="en">', '<html lang="en" data-codez-browser-extension="true">')
    .replace(inlineScriptRegex, '<script src="./bootstrap-theme.js"></script>');
  return {
    html: transformedHtml,
    scriptContent,
  };
}

async function collectRelativeFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.endsWith(".map")) continue;
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectRelativeFiles(rootDir, fullPath)));
    } else if (entry.isFile()) {
      files.push({
        fullPath,
        relativePath: relative(rootDir, fullPath).replaceAll("\\", "/"),
      });
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function packExtensionDirectoryToZip(sourceDir, zipFilePath) {
  const { ZipFile } = require("yazl");
  const zip = new ZipFile();
  const files = await collectRelativeFiles(sourceDir);
  for (const file of files) {
    zip.addFile(file.fullPath, file.relativePath, {
      mtime: new Date(1980, 0, 1, 0, 0, 0, 0),
      mode: 0o100644,
      forceDosTimestamp: true,
    });
  }
  zip.end();
  await mkdir(dirname(zipFilePath), { recursive: true });
  await pipeline(zip.outputStream, createWriteStream(zipFilePath));
}

export async function stageWebRemoteExtensionFromDist({
  distDir = join(repoRoot, "packages/web/dist"),
  outDir = join(repoRoot, "packages/web/dist-extension"),
  zipPath = join(repoRoot, "packages/web/dist-extension.zip"),
  iconsSourceDir = join(repoRoot, "public/logo/icons"),
  version,
} = {}) {
  const resolvedVersion =
    version ??
    JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")).version;
  const indexHtmlPath = join(distDir, "index.html");
  const rawHtml = await readFile(indexHtmlPath, "utf8");
  const { html, scriptContent } = extractInlineBootstrapScriptForExtension(rawHtml);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await cp(distDir, outDir, {
    recursive: true,
    filter: (src) => !src.endsWith(".map"),
  });

  await writeFile(join(outDir, "index.html"), html, "utf8");
  await writeFile(join(outDir, "bootstrap-theme.js"), scriptContent, "utf8");
  await writeFile(
    join(outDir, "manifest.json"),
    `${JSON.stringify(createWebRemoteExtensionManifest(resolvedVersion), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(outDir, "rules.json"),
    `${JSON.stringify(createWebRemoteExtensionRules(), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(outDir, "background.js"),
    createWebRemoteExtensionBackgroundScript(),
    "utf8",
  );

  const iconsOutDir = join(outDir, "icons");
  await mkdir(iconsOutDir, { recursive: true });
  for (const size of ["16x16.png", "32x32.png", "48x48.png", "128x128.png"]) {
    const sourceIcon = join(iconsSourceDir, size);
    await stat(sourceIcon);
    await copyFile(sourceIcon, join(iconsOutDir, size));
  }

  if (zipPath) {
    await rm(zipPath, { force: true });
    await packExtensionDirectoryToZip(outDir, zipPath);
  }

  return { outDir, zipPath, version: resolvedVersion };
}

export async function buildWebRemoteExtension({
  outDir = join(repoRoot, "packages/web/dist-extension"),
  zipPath = join(repoRoot, "packages/web/dist-extension.zip"),
  codezEnv = process.env.CODEZ_ENV || "production",
} = {}) {
  runCommand("pnpm", ["--filter", "@codez/web", "exec", "vite", "build", "--base=./"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEZ_ENV: codezEnv,
    },
  });
  return stageWebRemoteExtensionFromDist({
    distDir: join(repoRoot, "packages/web/dist"),
    outDir,
    zipPath,
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await buildWebRemoteExtension();
  console.log(
    `[web-remote-extension] Built v${result.version}: dir=${result.outDir} zip=${result.zipPath}`,
  );
}
