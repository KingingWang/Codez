# 浏览器控制与计算机控制隔离

## 产品规则与所有者

- `nativeBrowserControlEnabled` 只控制 `browser_command`，由 Desktop Main 持有并执行。
- 官方 Computer Use 插件的 workspace enablement 只控制 `cua_status` / `cua_command`，
  由本地 Host 持有；Helper 是能力提供者，不是 Agent 生命周期 owner。
- 两条能力可以复用 MCP 进程，但不能用任一能力的开关、健康状态或权限探测决定另一条的注册。
- 远端 workspace 仍只有窗口授权的 browser relay，不获得本机 CUA 凭据。
- 禁用后的调用必须在实际 dispatch 前拒绝；不因工具声明缓存而越过开关。
- Helper 冷启动超过旧的 1 秒 spawn 预算，不得使同一 Agent 永久失去 CUA。
  恢复不得通过 Helper ready 后回收 Agent 实现，也不得单纯增加 spawn 超时。

## 工具矩阵

| 浏览器 | 计算机 | 本地工具                    |
| ------ | ------ | --------------------------- |
| 关闭   | 关闭   | 无                          |
| 开启   | 关闭   | `browser_command`           |
| 关闭   | 开启   | `cua_status`、`cua_command` |
| 开启   | 开启   | 三者全部                    |

工具声明表示该能力被用户启用，不表示 Windows 原生后端或系统权限已经正常。
可恢复的 Helper 准备状态应在调用边界表达，不永久固化为缺失工具。
Host hello 中既有聚合 `nativeBrowserCuaMcp` 能力继续读取进程注入的可用性事实：
两者可用为 `supported`、仅一者可用为 `degraded`、两者均不可用为 `unsupported`。
该聚合展示不是任何一种工具的注册或 dispatch 授权。

## 状态与顺序

```text
浏览器设置 → Main browser dispatch gate ──→ browser_command
                      │
                      └→ 窗口 browser 事实 → Host → 远端 browser relay

Computer Use 插件 → Local Host → Helper transport/readiness → cua_status / cua_command
                       │
                       └→ CUA 凭据只授予该本地 MCP，不授予远端 workspace
```

Main 的 endpoint/window token 生命周期不再等同于浏览器启用状态。浏览器关闭后保留本地
CUA 所需的注册载体，但 browser dispatch 和 remote relay 必须立即拒止。
沿用现有配置生效边界；Helper ready/recovery 不能触发 Agent 重启。
当前用户切换设置仍会重建任务运行时，可能打断进行中的调用；本次工具注册隔离不承诺
运行中切换无中断。该限制与 Helper 冷启动恢复是不同的生命周期边界。

Local Host 在用户私有数据目录下持有单一 grant 文件投影。只有当前 Helper 的认证
ready 完成后才原子写入完整 socket/capability/generation；dispose 先 fence 晚结果再删除。
该文件路径仅传给本地 CUA MCP，远端和通用 Agent 环境不接收。MCP 在每次 CUA 调用
边界读取，不在启动期缓存凭据；缺失时只做有界、可取消的 demand wait，不在空闲时轮询。
所有能生成凭据的 Host start/restart 入口都必须发布结果；restart 开始时撤销旧投影，
成功后原子发布当前结果，失败不得留下旧授权。复用 transport 的重启也走同一发布边界，
不依赖 restart 实现是否间接调用公开 `start()`。

## Windows 原生失败的语义

- `available: true` 只表示 Helper broker 可访问。
- 应用枚举超时不能被报告为已确认的 accessibility 权限拒绝。
- 明确的系统拒绝仍是 `denied`；探测超时或其它不可归因异常应是 `unknown`，保留可诊断原因。
- Windows `0x800705B4` / HRESULT `-2147023436` 等已知超时必须归类为 `timeout`。
  对尚未发送动作的观察调用可报告可重试，但不能自动重放可能已发送的输入动作。
- 原生枚举中单个无响应窗口不能令所有应用控制永久不可用；具体修复必须以固定版本上游源码
  和回归证据为依据，不以空应用列表伪装成功，不添加新的依赖。
- Windows 应用发现改用 Win32 顶层可见窗口/PID 元数据，不执行全桌面 UIA 查询；
  仅在选定唯一应用后通过 `App.byPid` 绑定目标。显式 PID 直接绑定，不先列全桌面。
  发现失败保留错误，目标绑定失败不自动启动第二个进程；其它平台保持原有发现路径。
  Windows accessibility 探测使用前台应用的目标化读取，不再以全桌面应用枚举推断权限。

依据：固定依赖 `xa11y@0.15.0`（上游 commit
`a3badccf5761615ea3412ee55c19ac3764e27913`）的 `xa11y-windows/src/uia.rs`
在 `get_children(None)` 使用无 PID 限制的 desktop-root `FindAllBuildCache`。
`App.byPid` 使用 PID 条件的 `FindFirstBuildCache`，`App.windows()` 仍使用 PID 条件的
desktop-root 查询；因此此改动移除了全局应用枚举依赖，但不能把目标化 UIA 也一定正常
当作静态源码已证明的事实，必须保留 Windows 实机验收。

## 验收场景

1. 四种开关组合逐一验证工具列表；关闭任一项后另一项继续可调用。
2. 浏览器关闭、Computer Use 开启时，`cua_command` 不读取浏览器 token 或连接浏览器 broker。
3. Computer Use 关闭时，即使有继承的旧 Helper 凭据，也不能执行 CUA。
4. Helper 超过 1 秒才 ready，同一 MCP 在 ready 后可调用，不回收 Agent。
5. Helper 不可用、应用枚举超时、截图探测失败均不移除浏览器工具。
6. 远端浏览器开关关闭后 relay 不授权；任何组合都不下发本机 CUA。
7. 模拟 Windows 原生枚举超时：权限不是 `denied`，错误为 `timeout`，观察调用未发送动作。
8. Windows 真机：列出应用、读取计算器状态、执行一次可核对的输入；
   浏览器独立完成 `getState` / `navigate` / `snapshot`。

Linux 上的模拟与单测不能替代第 8 项；交付必须明确实际执行和待真机确认的证据。
