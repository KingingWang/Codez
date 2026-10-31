# Web 远控原生 / 扩展 IO

精确登记 `webRemoteControlNativeSocket.ts`；本目录提供 contract 与未来按职责拆分的
adapters，不接管 Web app。公开的 WebSocket/fetch 工厂仍由 main 装配到既有 transport，
不会建立第二个配对、加密、bootstrap 或任务 owner。

Android Socket/HTTP registry 只归 Android adapter；扩展 bridge 与页面不可预测 ID
只归扩展 adapter。原生/扩展层只搬运字节，E2EE、认证与 workspace 路由仍在上层。
AbortSignal、关闭与代际检查拒绝迟到响应，callback/Promise 的重复交付只能结算一次。
扩展 HTTP 代理不能在失败时降级为可能被 403/CORS 阻断的页面跨源请求。

```text
main selects IO port → existing transport / E2EE → Android or extension adapter
                                                  → native bridge / service worker
same socket generation ← bytes / response         ← original request association
```

备份中的 facade 为 919 行；完整重放后按以下边界拆分以满足 800 行预算：

- `adapters/android.ts`：Android class、Socket/HTTP registry、ID seed 与 event sink；
  HTTP 请求仍返回原 registry 的 promise，不能增加 accepted queue 或第二次请求。
- `adapters/extension.ts`：扩展 class、registry、runtime/window listener、Orion/robots bridge、
  settled/abort 和既有首连期限；一次请求只拥有一个 completion。
- `adapters/encoding.ts`：无状态 Base64 与 header 编码，不持有连接或请求事实。
- 原 `webRemoteControlNativeSocket.ts` 仅选择原有工厂并转出原公开符号；不持有 registry。
  扩展 HTTP 仍在同一个 async 工厂等待原 request promise，结果转换同步执行，不另设恢复路径。

共享原生桥与事件形状在 contract.ts 单一定义。各 registry 和事件 sink 整体迁移到所属
adapter，不复制 ID seed、pending map 或 event listener，不改变 Orion/iPad 协议与原公开导出。

依据：[端到端加密](../../../../docs/web-remote-control/end-to-end-encryption.md)、
[上游集成](../../../../specs/upstream-main-integration.md)。
