# Desktop native browser control Main broker

Main 唯一持有进程 endpoint、每窗口 0600 token/capability、注册 single-flight 和 enable
事实；schema、timing-safe token 与存活 owner window 校验之后才调用既有 BrowserGuestManager。
无窗口、失效 token、关闭/禁用和 endpoint/token 失败均 fail-closed，不换窗口兜底。

每连接请求按字节累计，只扫描新 chunk 的换行，完整帧才 UTF-8/JSON/schema 校验。
原始接收字节保持 1 MiB 上限，溢出不截断、不 dispatch、不重发；close/abort/完成只
结算一次并释放监听。Response 由原调用结果产生，Host/bridge 各保持 32 MiB bound。

register 只在 endpoint ready 后写 token；revoke/close 只清理本实例拥有的 token/socket，
保留 stale endpoint 检查与其他窗口能力。载体、browser enable 和 local CUA 是不同事实。
纯 descriptor/availability 读取不保存任务、队列或第二份 Host 业务状态。

Factory 的 socket-server 注入端口仅供同一可信 Main 装配与可重复 framed-runtime 验收，
默认仍是 node:net.createServer；它不构成 UI/relay 命令、第二条 native dispatch 路径。
完整生命周期及事件顺序见 `specs/codex-desktop-native-browser-cua.md`。
