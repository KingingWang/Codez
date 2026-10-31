# Desktop product runtime

build 的 product flavor 是唯一输入；本模块集中派生显示名、协议/integration 身份、
data base、bootstrap settings、update feed 和 packaged remote assets 目录。不保存
会话、Host 连接或 updater 状态，也不在各消费点复制常量。

显示名 Codez 不承担 codex/preview 隔离：app ID、协议与 data base 继续区分。
Codex feed 保留随 arch 显式安装的 `${arch}-latest` channel；remote assets 路径指向
build-pinned codex-remote index，不能查询 latest Release 猜版本。

参数注入的路径保持平台语义。目录解析不把 workspaceIdentity 当作执行 cwd，也不触碰
原生 CODEX_HOME。验收沿用 `specs/codex-desktop-distribution.md` 和现有分发 runtime 测试。
