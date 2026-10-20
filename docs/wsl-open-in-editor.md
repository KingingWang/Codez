# 远程工作区文件使用本机应用打开

## 背景

WSL 远程工作区的 `workspacePath` 表示 WSL 内部 Linux 路径，例如 `/home/user/repo`。该路径必须继续交给远端 host / agent / terminal 使用，不能为了 Windows 桌面应用提前改写成 UNC 路径，否则会污染远程执行语义和 workspace identity。

但桌面标题栏的“Open in Editor”入口运行在 Windows main 进程里。如果直接把 `/home/user/repo` 传给 Windows 侧 VS Code 或资源管理器，宿主会把它当成本机路径，导致打开失败或打开错误位置。

## 设计

- WSL 远程工作区打开 VS Code / VS Code Insiders 时，main 进程构造 VS Code Remote-WSL URI：目录使用 `--folder-uri`，文件使用 `--file-uri`。
- WSL 远程工作区打开 Zed 时，main 进程解析 WSL distro 并构造 `\\wsl.localhost\<distro>\...` UNC 路径交给 Windows 侧 Zed CLI / `Zed.exe` 打开；distro 缺失且无法解析默认发行版时返回明确错误，不裸传 Linux 路径。
- SSH 远程工作区打开 VS Code / VS Code Insiders 时，main 进程构造 VS Code Remote-SSH URI：优先使用显式 `sshConfigAlias`；当连接未携带 `sshConfigAlias` 时，自动从本机 `~/.ssh/config` 匹配同 `(host, port, username)` 的唯一或首个 alias，避免 VS Code Remote-SSH 因未命中 alias 丢失非默认端口或私钥配置；无匹配 alias 时回退编码 `user@host[:port]` authority。
- SSH 远程工作区打开 Zed 时，main 进程构造 Zed `ssh://` 远程 URI：优先使用显式 `sshConfigAlias` 或本机 `~/.ssh/config` 匹配的 alias 生成 `ssh://<alias>/<encoded-path>`；无匹配 alias 时按标准 `ssh://[encoded-user@]host[:port]/<encoded-path>` 构造。执行时优先调用 Zed 应用包内置 CLI（macOS 为 `<Zed.app>/Contents/MacOS/cli`，Windows 为 `<ZedDir>\bin\zed.exe`），缺失或失败时再回退到 `zed` 命令与系统应用打开链路。
- 桌面端打开 VS Code 远程 URI（`--folder-uri` / `--file-uri`）时，优先解析并执行 VS Code 应用包内置 CLI（macOS 为 `<App>/Contents/Resources/app/bin/<command>`，Windows 为 `<AppDir>\bin\<command>.cmd` 或 `Code.exe`），避免 macOS GUI 进程缺少 `PATH` 回退到 `open -a ... --args` 导致已运行实例忽略 `--args` 参数、或 Windows `execFile` 无法直接执行无扩展名命令的问题。
- WSL 远程工作区打开 Windows 资源管理器时，main 进程只在平台边界临时把 Linux 路径转换为 UNC 候选路径：优先 `\\wsl.localhost\<distro>\...`，失败再回退 `\\wsl$\<distro>\...`；文件使用 `/select,` 定位，目录直接打开。
- 不支持把 WSL Linux 路径直接传给其它未适配的本机编辑器。UI 只展示 VS Code / VS Code Insiders / Zed / 资源管理器，避免 Cursor、JetBrains、Terminal 等本机应用误用 Linux 路径。
- 如果 WSL target 缺少 distro，main 进程通过 `wsl.exe -l -v --all` 解析默认发行版；解析失败时才返回明确错误，不再 fallback 到裸传 Linux 路径。
- SSH 远程文件只展示支持远程 SSH URI 的 VS Code / VS Code Insiders / Zed；Docker 等没有本机路径映射的目标不展示本机编辑器，避免把 Linux path 当成本地路径。
- 对话 Markdown 链接、Assistant Preview Card、变更摘要和 Diff 预览必须同时携带 `workspacePath`、`workspaceIdentity` 与 `workspaceRemoteSessionId`。远程目标匹配使用 identity/session 消除同路径多远端歧义，路径展示和执行仍使用 `workspacePath`。
- Markdown 链接只能把显式尾随 `/` 作为目录展示提示，不能根据扩展名猜测文件系统类型。“打开方式”动作必须先通过当前 workspace scope 的文件服务执行 `stat`，再把真实 `file/directory` 作为 `pathKind` 传到 main 进程；无法确认类型时不得调用本机编辑器。目录使用 `--folder-uri` 或直接打开 Explorer，文件使用 `--file-uri` 或 Explorer `/select,`。
- 工作区文件树、审查区变更文件和项目/任务菜单中的文件管理器动作必须复用同一份远程目标解析结果。只有精确匹配到 WSL target 时才允许调用 Windows Explorer；审查区和项目菜单保持“打开目录”语义，传入 `pathKind: "directory"`。SSH、Docker 不开放本机文件管理器入口。
- 远程能力过滤产生的编辑器 fallback 只用于当前界面，不得覆盖用户的全局编辑器偏好；只有用户显式选择编辑器时才允许持久化。

## 影响面

- 平台路径转换只发生在桌面端：WSL 使用 Remote-WSL URI/UNC，SSH 使用 Remote-SSH URI；Web 和手机端仍不直接启动本机应用。
- UI 的能力过滤和 workspace scope 贯穿同时覆盖 WSL、SSH、Docker 与普通本地 workspace。Docker 因没有可靠的宿主路径映射而失败关闭。
- 普通本地 workspace 继续按本机路径打开，不要求 `workspaceIdentity`。
- 原生 Windows、macOS、Linux 的文件管理器动作继续走既有本机平台实现；WSL 分支只在远程身份精确解析为 WSL 时生效。
- 不改变远程 host、agent、terminal、Web 远控、task realtime 或 workspace identity 语义。
