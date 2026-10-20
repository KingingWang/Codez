# E2EE-05 手机远控扫码与恢复（manual-review/pending）

本场景尚未进入自动化或正式覆盖。执行前必须有独立于 relay 管理权限的可信 HTTPS
静态站点 `https://kingingwang.github.io/Codez/remote/v4/`、使用 `/Codez/remote/v4/`
资源 base 构建的页面、真实手机浏览器，以及 relay 接受该页面
WebSocket Origin 的证据。不要把旧 `mobile-remote-upstream.mjs` 的原样上游页面当成
加密客户端；其 MOBILE-UPSTREAM-01/02 只保留为历史协议兼容证据。

1. 确认 GitHub Pages 项目入口与 JS/CSS/PDF.js 资源均可访问；在隔离 Desktop 窗口打开
   一个本地 workspace 与已有 task；启动手机远控并截图二维码，
   记录浏览器请求、relay 仅含元数据与密文的抓包摘要，以及 Main 的安全原因码。
2. 手机扫码，验证同一 workspace 的任务首页可见；进入 task、发送
   `E2E_MOBILE_ENCRYPTED_FIRST`，确认唯一 Host/CLI 只 admission 一次，Desktop continuous
   与手机 replayable 看到相同 terminal projection。
3. 手机页面刷新、切后台再返回并断开/恢复网络；确认重新握手、同 task snapshot/gap
   对账、输入不重复。运行中再次发送 `E2E_MOBILE_ENCRYPTED_QUEUE`，按现有 CLI
   CommandInbox FIFO 收口，不因重连制造第二份队列。
4. 使用旧 QR、缺 fragment 的链接及在本地代理中篡改密文；新版桌面不得 attach
   workspace 或执行 command，手机显示明确失败。刷新桌面二维码后旧链接不再可用。
5. 远程 workspace 代表场景验证 `workspaceIdentity + remoteSessionId` 的准确路由；
   切换手机选中 task 不影响桌面选中态、其他窗口或其他 workspace。

验收证据：手机页面截图/视频、网络 `data.payload` 无正文/密钥的抓包、Host attachment
数量、CLI commandId/admission 与 projection、桌面 continuous 不间断的事件记录。
未取得真实 relay Origin/opaque payload 证据或独立站点发布权限前保持 pending，
不晋级 formal，也不把本地 mock 结果标为线上 E2EE 可用。
