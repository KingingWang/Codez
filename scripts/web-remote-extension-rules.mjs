/**
 * Manifest V3 的 declarativeNetRequest 规则仅改写 zcode API 的 Origin/Referer。
 * 扫码链接与 OAuth 回调的页面重定向由 content script/background 完成，以保留
 * `?sid=...` 与 `#e2ee=...`，避免 DNR transform 造成 GitHub Pages 404 或密钥丢失。
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
