# 原生 Browser / CUA 协议

精确登记 `browser-use/nativeMcp.ts` 与 `browser-use/nativeCuaMcp.ts`；
复用 shared 的 BrowserCommand/Result，不接管整个 browser-use 目录。schema、路径构造
和预算常量均为纯 contract，不执行浏览器、桌面或文件操作。

Main 是窗口 capability owner；本地 Host 与 Codex 复用既有 MCP/broker 路径。
远端 relay 只获 Browser 能力，不能取得本地 CUA Helper 凭据。请求、结果与错误继续
严格校验；窗口关闭或凭据失效必须 fail closed，不能按请求选择另一个窗口。

```text
Main live capability → Host scoped MCP → validated request → existing broker
                     ← validated result ← window-bound browser / local CUA
```

32 MiB 响应预算由此协议声明，完整字节帧的累计/解码与 fail-closed 仍由 broker adapter
承担；登记不增加帧缓存、第二条执行路径或任务状态。

依据：[原生 Browser/CUA](../../../../specs/codex-desktop-native-browser-cua.md)、
[控制隔离](../../../../specs/computer-and-browser-control-isolation.md)。
