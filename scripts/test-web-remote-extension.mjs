import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
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
    { header: "Referer", operation: "set", value: "https://zcode.z.ai/remote/v4" },
  ]);
  assert.ok(Array.isArray(originRule.action.responseHeaders));
  assert.ok(originRule.condition.resourceTypes.includes("websocket"));
  assert.ok(originRule.condition.resourceTypes.includes("xmlhttprequest"));

  const contentScript = createWebRemoteExtensionContentScript();
  assert.ok(contentScript.includes("setAttribute('data-codez-browser-extension', 'true')"));
  assert.ok(contentScript.includes("codez-redirect-to-extension"));
  assert.ok(contentScript.includes("loc.search"));
  assert.ok(contentScript.includes("loc.hash"));
  assert.ok(!contentScript.includes("codez-extension-ws-cmd-bridge"));
  assert.ok(!contentScript.includes("codez-extension-http-fetch-req"));

  const backgroundScript = createWebRemoteExtensionBackgroundScript();
  assert.ok(backgroundScript.includes("codez-redirect-to-extension"));
  assert.ok(backgroundScript.includes("resolveExtensionRedirectTarget"));
  assert.ok(backgroundScript.includes("injectExtensionMarkerAndRedirectExistingTabs"));
});

test("后台桥未收到 content script 就绪回执时不把标签页存在误当成 WebSocket 可用", async () => {
  const messageListeners = [];
  const timers = [];
  const emitted = [];
  const sentToBridge = [];
  const api = {
    runtime: {
      getURL: (path) => `chrome-extension://codez/${path}`,
      onMessage: { addListener: (listener) => messageListeners.push(listener) },
      sendMessage: (message) => emitted.push(message),
    },
    tabs: {
      query: async () => [],
      create: async () => ({ id: 17 }),
      sendMessage: async (...args) => sentToBridge.push(args),
    },
  };
  runInNewContext(createWebRemoteExtensionBackgroundScript(), {
    chrome: api,
    URL,
    WebSocket: undefined,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout: () => {},
  });
  const onMessage = messageListeners[0];
  assert.equal(typeof onMessage, "function");
  onMessage(
    {
      type: "codez-extension-ws-open",
      id: "a".repeat(32),
      url: "wss://zcode.z.ai/api/v1/remote/ws2?token=diagnostic-only",
    },
    { tab: { id: 7 } },
    () => {},
  );
  await new Promise((resolve) => setImmediate(resolve));
  const readyDeadline = timers.find((timer) => timer.ms === 6000);
  assert.ok(readyDeadline);
  readyDeadline.fn();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    sentToBridge.filter(
      ([tabId, message]) => tabId === 17 && message.type === "codez-bridge-ws-open",
    ).length,
    0,
  );
  assert.deepEqual(
    emitted
      .filter((message) => message.type === "codez-extension-ws-event")
      .map((message) => message.event.type),
    ["error", "close"],
  );
});

test("Orion 先回桥就绪、后回 tabs.create 的次序仍能建立同源 socket", async () => {
  const listeners = [];
  const sent = [];
  let completeCreate;
  const api = {
    runtime: {
      getURL: (path) => `orion-extension://codez/${path}`,
      onMessage: { addListener: (listener) => listeners.push(listener) },
      sendMessage: () => {},
    },
    tabs: {
      query: async () => [],
      create: () => new Promise((resolve) => { completeCreate = resolve; }),
      sendMessage: async (...args) => sent.push(args),
    },
  };
  runInNewContext(createWebRemoteExtensionBackgroundScript(), {
    chrome: api,
    URL,
    WebSocket: undefined,
    setTimeout: (fn, ms) => ({ fn, ms }),
    clearTimeout: () => {},
  });
  const onMessage = listeners[0];
  onMessage(
    {
      type: "codez-extension-ws-open",
      id: "b".repeat(32),
      url: "wss://zcode.z.ai/api/v1/remote/ws2?token=diagnostic-only",
    },
    { tab: { id: 8 } },
    () => {},
  );
  await new Promise((resolve) => setImmediate(resolve));
  // Orion 的 sender.tab 可能为空，且 tabs.create Promise 可能晚于注入回执。
  onMessage({ type: "codez-bridge-ready" }, {}, () => {});
  completeCreate({ id: 19 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    sent.some(
      ([tabId, message]) => tabId === 19 && message.type === "codez-bridge-ws-open",
    ),
  );
});

test("静态同源桥只接受本项目的 relay WebSocket 目标", () => {
  const windowListeners = [];
  const opened = [];
  const mockWindow = {
    location: {
      protocol: "https:",
      hostname: "zcode.z.ai",
      pathname: "/robots.txt",
      search: "",
      hash: "",
    },
    addEventListener: (_type, listener) => windowListeners.push(listener),
  };
  mockWindow.parent = { postMessage: () => {} };
  const api = {
    runtime: {
      sendMessage: () => {},
      onMessage: { addListener: () => {} },
      getURL: (path) => `orion-extension://codez/${path}`,
    },
  };
  class MockWebSocket {
    constructor(url) {
      opened.push(url);
    }
    addEventListener() {}
  }
  runInNewContext(createWebRemoteExtensionContentScript(), {
    window: mockWindow,
    chrome: api,
    URL,
    URLSearchParams,
    WebSocket: MockWebSocket,
    Number,
  });
  const onMessage = windowListeners[0];
  assert.equal(typeof onMessage, "function");
  onMessage({
    source: mockWindow.parent,
    origin: "orion-extension://codez",
    data: {
      type: "codez-bridge-ws-open",
      id: "a".repeat(32),
      url: "wss://attacker.example/collect",
    },
  });
  assert.deepEqual(opened, []);
});

test("Orion 的 chrome.runtime 只能发送时，同源桥改用可双向通信的 browser.runtime", () => {
  const messages = [];
  const mockWindow = {
    location: {
      protocol: "https:",
      hostname: "zcode.z.ai",
      pathname: "/robots.txt",
      search: "",
      hash: "",
    },
    addEventListener: () => {},
  };
  mockWindow.parent = mockWindow;
  runInNewContext(createWebRemoteExtensionContentScript(), {
    window: mockWindow,
    chrome: {
      runtime: {
        sendMessage: () => {},
        getURL: (path) => `orion-extension://incomplete/${path}`,
      },
    },
    browser: {
      runtime: {
        sendMessage: (message) => messages.push(message),
        onMessage: { addListener: () => {} },
        getURL: (path) => `orion-extension://codez/${path}`,
      },
    },
    URLSearchParams,
  });
  assert.ok(messages.some((message) => message.type === "codez-bridge-ready"));
});

test("Orion 后台也选用具备 onMessage 与标签页桥能力的 browser API", () => {
  const listeners = [];
  const chromeApi = {
    runtime: {
      sendMessage: () => {},
      getURL: (path) => `orion-extension://incomplete/${path}`,
    },
    tabs: { create: async () => ({ id: 1 }) },
  };
  const browserApi = {
    runtime: {
      sendMessage: () => {},
      getURL: (path) => `orion-extension://codez/${path}`,
      onMessage: { addListener: (listener) => listeners.push(listener) },
    },
    tabs: {
      create: async () => ({ id: 2 }),
      sendMessage: async () => {},
      query: async () => [],
    },
  };
  runInNewContext(createWebRemoteExtensionBackgroundScript(), {
    chrome: chromeApi,
    browser: browserApi,
    URL,
    setTimeout,
    clearTimeout,
  });
  assert.equal(listeners.length, 1);
});

test("iframe 桥的密文消息只回传父扩展页面一次，不再同时广播到 background", () => {
  const parentEvents = [];
  const runtimeEvents = [];
  const socketListeners = new Map();
  const windowListeners = [];
  const wsUrl = "wss://zcode.z.ai/api/v1/remote/ws2?token=diagnostic-only";
  const id = "c".repeat(32);
  const parent = { postMessage: (message) => parentEvents.push(message) };
  const mockWindow = {
    parent,
    location: {
      protocol: "https:",
      hostname: "zcode.z.ai",
      pathname: "/robots.txt",
      search: `?codez_ws_iframe_id=${id}`,
      hash: `#${encodeURIComponent(wsUrl)}`,
    },
    addEventListener: (_type, listener) => windowListeners.push(listener),
  };
  class MockWebSocket {
    constructor() {}
    addEventListener(type, listener) {
      socketListeners.set(type, listener);
    }
  }
  runInNewContext(createWebRemoteExtensionContentScript(), {
    window: mockWindow,
    chrome: {
      runtime: {
        sendMessage: (message) => runtimeEvents.push(message),
        onMessage: { addListener: () => {} },
        getURL: (path) => `orion-extension://codez/${path}`,
      },
    },
    URL,
    URLSearchParams,
    WebSocket: MockWebSocket,
  });
  const onMessage = windowListeners[0];
  onMessage({
    source: parent,
    origin: "orion-extension://codez",
    data: { type: "codez-bridge-ws-open", id, url: wsUrl },
  });
  socketListeners.get("message")({ data: "encrypted-frame" });

  assert.deepEqual(
    parentEvents.filter((event) => event.type === "codez-extension-ws-event").map((event) => event.event.text),
    ["encrypted-frame"],
  );
  assert.equal(
    runtimeEvents.filter((event) => event.type === "codez-bridge-ws-event").length,
    0,
  );
});

test("任意网页不能借 robots.txt iframe 的 fragment 或 postMessage 洗白 relay Origin", () => {
  const parentEvents = [];
  const opened = [];
  const windowListeners = [];
  const id = "d".repeat(32);
  const wsUrl = "wss://zcode.z.ai/api/v1/remote/ws2?token=diagnostic-only";
  const parent = { postMessage: (message) => parentEvents.push(message) };
  const mockWindow = {
    parent,
    location: {
      protocol: "https:",
      hostname: "zcode.z.ai",
      pathname: "/robots.txt",
      search: `?codez_ws_iframe_id=${id}`,
      hash: `#${encodeURIComponent(wsUrl)}`,
    },
    addEventListener: (_type, listener) => windowListeners.push(listener),
  };
  class MockWebSocket {
    constructor(url) {
      opened.push(url);
    }
    addEventListener() {}
  }
  runInNewContext(createWebRemoteExtensionContentScript(), {
    window: mockWindow,
    chrome: {
      runtime: {
        sendMessage: () => {},
        onMessage: { addListener: () => {} },
        getURL: (path) => `orion-extension://codez/${path}`,
      },
    },
    URL,
    URLSearchParams,
    WebSocket: MockWebSocket,
  });
  assert.deepEqual(opened, []);
  assert.ok(parentEvents.some((event) => event.type === "codez-bridge-ready"));
  const onMessage = windowListeners[0];
  onMessage({
    source: parent,
    origin: "https://attacker.example",
    data: { type: "codez-bridge-ws-open", id, url: wsUrl },
  });
  onMessage({
    source: parent,
    origin: "null",
    data: { type: "codez-bridge-ws-open", id, url: wsUrl },
  });
  assert.deepEqual(opened, []);
  onMessage({
    source: parent,
    origin: "orion-extension://codez",
    data: { type: "codez-bridge-ws-open", id, url: wsUrl },
  });
  assert.deepEqual(opened, [wsUrl]);
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
