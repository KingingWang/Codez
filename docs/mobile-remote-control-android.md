# Android 远程控制壳

`packages/android` 当前是 Codez 手机远控的 Android 壳。不重写 Codez Agent、relay 或
RPC 协议，而是用原生入口承载现有 `/remote` 手机 Web 远控页面。

## 原生 WebSocket 桥（Origin 放行）

远控 relay（`wss://zcode.z.ai/ws`）按 WebSocket 握手里的 `Origin` 头做来源白名单。
浏览器与 WebView 的 `Origin` 由渲染进程按页面 origin 自动附加，页面脚本无法改写：
fork 发布页 `https://kingingwang.github.io/Codez/remote/v4/` 不在白名单内，握手会被
403 拒绝；官方页（`https://zcode.z.ai`）和桌面端（Node `ws`，不带 `Origin`）放行。

因此 App 内的远控页面不直接使用 WebView 自带 WebSocket，而是由原生网络栈代发：

- 原生侧 `NativeSocketBridge`（OkHttp WebSocket，不附加 `Origin` 头）通过
  `window.CodezAndroidSocket` JavascriptInterface 暴露 `open/sendText/sendBinary/close`。
- Web bundle 内 `resolveWebRemoteControlWebSocketCtor()`
  （`packages/web/src/webRemoteControlNativeSocket.ts`）检测到该桥时返回一个实现浏览器
  WebSocket 子集的适配类，`WebRemoteControlTerminalTransport` 经既有 `WebSocketCtor`
  注入点使用；无桥环境（普通浏览器）仍回退到原生 `WebSocket`。
- 原生事件经 `window.__codezAndroidSocketEvent(id, json)` 回派：文本帧原样传递，二进制帧
  （relay-gzip 信封）以 base64 传递、JS 侧还原为 `ArrayBuffer`。

E2EE 握手、配对鉴权、RPC 帧、重连与恢复状态机全部留在 Web bundle；原生桥只搬运字节，
不知道业务协议，也不会接触明文以外的密钥材料（E2EE 密钥只存在于 JS 侧）。

## 多设备首页

App 首页面向"一部手机连接多台桌面"的场景：

- 主操作是扫码连接（CameraX + ML Kit）；手动粘贴链接作为兜底入口。
- 最近连接以设备卡片列表展示：设备名（QR `name` 参数）、页面 host、相对时间，
  点按即重连；支持单条删除与全部清空。
- 卡片只展示元信息；完整链接（含配对凭据）保存在 App 私有 `SharedPreferences`。

## 全屏远控页

远控页打开后进入沉浸式全屏：隐藏系统状态栏与导航栏（沉浸模式，上滑可短暂呼出），
不显示 App 自身的顶栏，整个屏幕交给远控 Web 页面。退出远控页（返回手势或页面自身
断开）时恢复系统栏。刘海/挖孔区域保持默认避让，不强制内容延伸到打孔下，避免页面
头部被摄像头遮挡。

## 附件选择

WebView 不会自动处理 `<input type="file">`：必须实现
`WebChromeClient.onShowFileChooser` 并拉起系统文件选择器，否则页面点附件无反应
（浏览器自带该处理）。实现按 `FileChooserParams.createIntent()` 构造选择器（尊重页面
accept 类型与多选模式），结果经 `WebChromeClient.FileChooserParams.parseResult` 回传；
用户取消时必须回调 `onReceiveValue(null)`，否则页面 input 会卡死。

## 入口

- 粘贴或分享远控链接。
- 扫描桌面端生成的远控二维码。
- 通过 `codez://remote?...` deep link 打开。
- 首页保存最近 5 条成功打开过的远控链接，App 重启后可以直接点开。

生产包允许打开 fork 发布页 `https://kingingwang.github.io/Codez/remote` 前缀与官方
`https://zcode.z.ai/remote`。Debug 包额外允许 localhost 和局域网 `/remote`，方便真机
调试本地 Vite 页面。

## 扫码

扫码使用 CameraX 预览和 ML Kit Barcode Scanning。扫描器只识别 QR Code，扫到内容后仍交给
`RemoteControlUrlPolicy` 校验，非法链接不会进入 WebView。

## 后台稳定性

远控页面打开后，App 会启动前台服务并保持屏幕常亮。前台服务的作用是降低 Android 在后台回收进程
或收紧网络的概率；它不改变业务事实源。手机端断线或恢复仍依赖现有 Web 远控的
`web-remote-replayable` 语义、bridge 重建和 task snapshot 对齐。

Android App 不创建独立 Agent runtime、local host 或 SSH/WSL/Docker session。手机端仍只能 attach
到桌面窗口已经存在的 host。

## 发布

APK 通过仓库 GitHub Releases 分发（`.github/workflows/android-app.yml`），不上架应用商店。
配置了 `ANDROID_KEYSTORE_BASE64` 等签名 secret 时发布签名版 APK；未配置时回退为 debug 签名
（Android 不允许安装完全未签名的 APK）。两种情况都可用 `adb install` 或系统安装器直接安装，
签名在发布间保持稳定即可覆盖升级。
