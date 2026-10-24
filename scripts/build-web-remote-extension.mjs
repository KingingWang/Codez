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
 * 仅保留将发往 https://zcode.z.ai/api/v1/*（含 HTTP 与 wss:// WebSocket）的请求头 Origin 设为 https://zcode.z.ai，
 * 解决本地扩展连接云端 relay 时的 403 拦截。
 *
 * 注意：页面级重定向（扫码打开 kingingwang.github.io/Codez/remote/v4/* 与 OAuth 回调 zcode.z.ai/remote/v4）
 * 不能使用 declarativeNetRequest 的 extensionPath/transform，否则 Chrome/Edge MV3 会丢弃 ?sid=... 查询串与 #e2ee=... 密钥片段，
 * 或在同域名变换路径时触发 GitHub Pages /index.html 404。页面接管统一由 redirect-content.js（document_start）与 background.js 完成。
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
          {
            header: "Referer",
            operation: "set",
            value: "https://zcode.z.ai/remote/v4",
          },
        ],
        responseHeaders: [
          {
            header: "Access-Control-Allow-Origin",
            operation: "set",
            value: "*",
          },
          {
            header: "Access-Control-Allow-Headers",
            operation: "set",
            value: "Authorization, Content-Type, Accept",
          },
          {
            header: "Access-Control-Allow-Methods",
            operation: "set",
            value: "GET, POST, PUT, DELETE, OPTIONS",
          },
        ],
      },
      condition: {
        urlFilter: "||zcode.z.ai/api/v1/*",
        resourceTypes: ["xmlhttprequest", "websocket", "other"],
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
    content_scripts: [
      {
        matches: [
          "https://kingingwang.github.io/Codez/remote/*",
          "https://zcode.z.ai/remote/*",
        ],
        js: ["redirect-content.js"],
        run_at: "document_start",
      },
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

export function createWebRemoteExtensionContentScript() {
  return [
    "// 1. 立即在 documentElement 标记已安装 Codez 浏览器扩展，确保 kingingwang.github.io 远控页不会弹出未安装扩展限制提示；",
    "// 2. 在 document_start 阶段拦截扫码链接与 OAuth 回调，完整保留 search 与 #e2ee 密钥 hash 跳转到本地扩展页。",
    "(() => {",
    "  const api = globalThis.chrome ?? globalThis.browser;",
    "  try {",
    "    if (document.documentElement) {",
    "      document.documentElement.setAttribute('data-codez-browser-extension', 'true');",
    "    } else {",
    "      document.addEventListener(",
    "        'DOMContentLoaded',",
    "        () => document.documentElement?.setAttribute('data-codez-browser-extension', 'true'),",
    "        { once: true },",
    "      );",
    "    }",
    "  } catch {",
    "    // ignore",
    "  }",
    "  if (api?.runtime?.sendMessage && typeof window !== 'undefined') {",
    "    window.addEventListener('message', (event) => {",
    "      if (event.source !== window || event.data?.type !== 'codez-extension-http-fetch-req') return;",
    "      const reqId = event.data.id;",
    "      try {",
    "        api.runtime.sendMessage(",
    "          {",
    "            type: 'codez-extension-http-fetch',",
    "            url: event.data.url,",
    "            method: event.data.method,",
    "            headers: event.data.headers,",
    "            body: event.data.body,",
    "          },",
    "          (resp) => {",
    "            window.postMessage(",
    "              {",
    "                type: 'codez-extension-http-fetch-res',",
    "                id: reqId,",
    "                response: resp || { status: 0, body: '', error: 'Empty extension response' },",
    "              },",
    "              '*',",
    "            );",
    "          },",
    "        );",
    "      } catch (err) {",
    "        window.postMessage(",
    "          {",
    "            type: 'codez-extension-http-fetch-res',",
    "            id: reqId,",
    "            response: { status: 0, body: '', error: String(err) },",
    "          },",
    "          '*',",
    "        );",
    "      }",
    "    });",
    "  }",
    "  if (!api?.runtime?.getURL) return;",
    "  const loc = window.location;",
    "  const normalizedPath = loc.pathname.replace(/\\/+$/u, '');",
    "  const isForkRemotePage =",
    "    loc.protocol === 'https:' &&",
    "    loc.hostname === 'kingingwang.github.io' &&",
    "    normalizedPath === '/Codez/remote/v4';",
    "  const params = new URLSearchParams(loc.search);",
    "  const isOfficialOAuthCallback =",
    "    loc.protocol === 'https:' &&",
    "    loc.hostname === 'zcode.z.ai' &&",
    "    normalizedPath === '/remote/v4' &&",
    "    params.has('state') &&",
    "    (params.has('code') || params.has('authCode') || params.has('error'));",
    "  if (!isForkRemotePage && !isOfficialOAuthCallback) return;",
    "  const targetUrl = `${api.runtime.getURL('index.html')}${loc.search || ''}${loc.hash || ''}`;",
    "  try {",
    "    api.runtime.sendMessage({",
    "      type: 'codez-redirect-to-extension',",
    "      search: loc.search || '',",
    "      hash: loc.hash || '',",
    "    });",
    "  } catch {",
    "    // ignore",
    "  }",
    "  try {",
    "    loc.replace(targetUrl);",
    "  } catch {",
    "    // 顶层从 https 导航到 chrome-extension:// 若被浏览器拦截，保留当前已标记 data-codez-browser-extension 的页面并由 background tabs.update 接管",
    "  }",
    "})();",
    "",
  ].join("\n");
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
    "async function injectExtensionMarkerAndRedirectExistingTabs() {",
    "  if (!api?.tabs?.query) return;",
    "  try {",
    "    const tabs = await api.tabs.query({",
    "      url: ['https://kingingwang.github.io/Codez/remote/*', 'https://zcode.z.ai/remote/*'],",
    "    });",
    "    for (const tab of tabs || []) {",
    "      if (tab?.id === undefined) continue;",
    "      const redirectUrl = resolveExtensionRedirectTarget(tab.pendingUrl || tab.url);",
    "      if (redirectUrl) {",
    "        void api.tabs.update(tab.id, { url: redirectUrl });",
    "      }",
    "    }",
    "  } catch {",
    "    // ignore",
    "  }",
    "}",
    "",
    "if (api?.runtime?.onInstalled) {",
    "  api.runtime.onInstalled.addListener(() => {",
    "    void injectExtensionMarkerAndRedirectExistingTabs();",
    "  });",
    "}",
    "void injectExtensionMarkerAndRedirectExistingTabs();",
    "",
    "if (api?.runtime?.onMessage) {",
    "  api.runtime.onMessage.addListener((message, sender, sendResponse) => {",
    "    if (message?.type === 'codez-extension-http-fetch') {",
    "      const rawUrl = typeof message.url === 'string' ? message.url : '';",
    "      if (!rawUrl.startsWith('https://zcode.z.ai/api/')) {",
    "        sendResponse({ status: 400, body: '', error: 'Unsupported extension fetch target' });",
    "        return false;",
    "      }",
    "      const method = typeof message.method === 'string' ? message.method : 'GET';",
    "      const headers =",
    "        message.headers && typeof message.headers === 'object' ? message.headers : {};",
    "      const body = typeof message.body === 'string' && method !== 'GET' && method !== 'HEAD' ? message.body : undefined;",
    "      fetch(rawUrl, {",
    "        method,",
    "        headers,",
    "        ...(body !== undefined ? { body } : {}),",
    "      })",
    "        .then(async (resp) => {",
    "          const text = await resp.text();",
    "          sendResponse({ status: resp.status, body: text });",
    "        })",
    "        .catch((err) => {",
    "          sendResponse({",
    "            status: 0,",
    "            body: '',",
    "            error: err instanceof Error ? err.message : String(err),",
    "          });",
    "        });",
    "      return true;",
    "    }",
    "    if (message?.type !== 'codez-redirect-to-extension') return false;",
    "    const tabId = sender?.tab?.id;",
    "    if (tabId === undefined || !api?.tabs?.update) return false;",
    "    const search = typeof message.search === 'string' ? message.search : '';",
    "    const hash = typeof message.hash === 'string' ? message.hash : '';",
    "    const targetUrl = `${api.runtime.getURL('index.html')}${search}${hash}`;",
    "    void api.tabs.update(tabId, { url: targetUrl });",
    "    return false;",
    "  });",
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
  await writeFile(
    join(outDir, "redirect-content.js"),
    createWebRemoteExtensionContentScript(),
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
