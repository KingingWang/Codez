# Codex 接管后的旧 OAuth 隔离

状态：已修复（2026-11-02）。恢复既有 Codex Root 启动隔离合同，不改变登录产品选择，
不新增账号 store、登录流程或轮询 owner。

## 证据与规则

实际浏览器 `qa/interaction-e2e.mjs` 显示：Codex 模式收到旧链接后仍调用
`oauthService.handleCallback`。`useRootOAuthEffects` 只限制缓存恢复，轮询和 deep link
没有接入运行时检查；现有 `setProviderFamilyDomain` 与
`refreshLatestModelProviderFamilySelectionAfterLogin` 的 `isCurrent` 参数也未被传入。

- Root 是登录效果唯一 owner。登录 scope 由 runtime、accountIntentKey、platform、services
  确定；更换回调依赖不制造新登录 scope。
- pending/Codex 仍登记 transport callback 并完成链接确认，但不调用旧 OAuth 业务处理。
- legacy 的有效登录照常处理。Host/runtime/身份切换或卸载立即撤销旧登录的后续效果：
  每个 await 后、后续 RPC/设置写入/账号投影/成功标记之前验证同一 scope。
  已发出的请求允许返回，不承诺回滚已完成的写入，不自动重试迟到结果。
- 复用已有 `isCurrent` 端口阻止读取旧设置后继续发 Provider RPC 或写旧选择。
- renderer-ready 在每个 platform attachment 的 callback 安装后通知一次；
  callback 依赖变化不重复 ready。轮询只在有效 legacy scope 中运行，卸载/接管清理 timer。
- 旧 scope 的重新登录提示使用现有 alert AbortSignal 撤销，仅关闭它自己持有的提示，
  不消费确认动作，也不关闭新 scope 的无关对话框。

```text
platform attachment → 安装 callback → renderer-ready（一次）
链接/轮询 → Root 当前 login scope → legacy 业务 IO → 当前 scope 复检 → 配置/账号投影
                     └─ pending/Codex：仅确认     └─ 已撤销：丢弃后续效果
```

桌面 continuous 和手机 replayable 均只复用原 attachment/Root，不新增账号或传输路径。

## 验收

沿用真实组件浏览器验收：Codex 旧链接零业务调用；延迟 deep link、轮询和设置读取后切到
Codex，零迟到账号写入/Provider 刷新/成功标记；当前 legacy 登录仍成功；重复回调依赖变化
不重复 ready。既有 `rootOAuthCallbackHandling`、family refresh 与缓存恢复 fork 回归维持。
浏览器假 Host 不替代真实 OAuth 服务或手机/SSH 端到端验收。

2026-11-02 冻结源码后的完整浏览器验收 52/52、page errors = 0，工件
`/tmp/codex-ui-interaction-e2e-IKa4ah`，覆盖以上回调/轮询/延迟设置读与旧提示撤销场景。
既有 OAuth/family fork 定向回归 19/19，实际外部 OAuth 服务仍未端到端验证。
