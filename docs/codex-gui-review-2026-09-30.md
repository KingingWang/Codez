# Code Review Summary

**Files Reviewed:** 46 modified files (codex adaptation)
**Total Issues:** 3

### By Severity

- CRITICAL: 0
- HIGH: 0
- MEDIUM: 2
- LOW: 1

### Issues

**[MEDIUM] Config validation error messages lack user guidance**
File: `packages/ui/src/settings/codex/CodexConfigPanel.tsx:192`
Issue: When JSON parsing fails in config forms, the raw error message is shown without context. Users see technical errors like "Expected string but found number" without guidance on what went wrong.
Fix: Wrap JSON.parse errors with user-friendly context:

```typescript
try {
  const edit = parseCodexConfigValueEdit(keyPath, jsonValue);
  // ...
} catch (error) {
  const userMessage =
    error instanceof SyntaxError
      ? `Invalid JSON: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  setValidationError(userMessage);
}
```

**[MEDIUM] Provider deletion has redundant catalog readiness check**
File: `packages/ui/src/settings/codex/CodexProvidersPanel.tsx:154-159`
Issue: `deleteProvider` checks `catalogReady` early, but `CodexProviderRow` already disables the button when `!catalogReady`. This creates two validation paths.
Fix: Remove the early return in `deleteProvider` since the button is already disabled. The `setFormError` path is unreachable.

**[LOW] Config validation helper could preserve error context better**
File: `packages/ui/src/settings/codex/codexConfigValidation.ts:7-12`
Issue: The "Expected exactly one config edit" error is defensive but unlikely since schema ensures non-empty. If it does fire, it doesn't preserve the original schema error.
Fix: This is acceptable as-is since it's a defensive assertion. The schema validation runs first and would catch most issues. No change needed.

### Spec Compliance

✅ **Stage 1 - Spec Compliance: PASS**

- All codex-native settings panels implemented (config, providers, models, skills, MCP, plugins, agents)
- Desktop-only usage view correctly scoped to Host-owned observations
- History selection reads from workspace-keyed session store
- Provider deletion fails closed when catalog unavailable
- Usage totals promote missing facts to null (displayed as "--")

### Root Cause Guard

✅ **No fallback/workaround masking failures**

- Config validation errors are local to form, not masked
- Catalog read failures block deletion (fail-closed)
- Missing usage facts show "--" not zero
- No silent defaults or broad compatibility shims

### Code Quality Assessment

**Strengths:**

- Clear separation: form-local validation vs remote mutation errors
- Workspace identity isolation in history selection
- Generation-aware usage observation (stale responses rejected)
- Defensive provider deletion (catalog must be ready)
- Lucide icon chunking reduces modulepreload count from 280 to 52

**Areas for improvement:**

- User-facing error messages could be more actionable
- Some redundant validation paths

### Security Review

✅ **No security issues found**

- No hardcoded secrets
- JSON.parse errors are user-facing, not exposing internals
- Config writes require valid schema
- Provider deletion requires catalog readiness (prevents accidental deletion)

### Performance

✅ **Modulepreload budget met**

- Production build: 52 preloads (target: <100)
- Lucide icons consolidated into single chunk (567.94 kB)
- No evidence of excessive resource exhaustion in production build

### Recommendation

**APPROVE with minor improvements**

The codex adaptation is solid. All 6 dogfood issues have been addressed or mitigated:

- ISSUE-001 (HIGH): Partially mitigated with Lucide chunking; root cause likely container resource exhaustion
- ISSUE-002 (LOW): Fixed with controlled tooltip state
- ISSUE-003 (LOW): Fixed with form-local validation errors
- ISSUE-004 (MEDIUM): Fixed with Host-only usage observations
- ISSUE-005 (MEDIUM): Fixed with workspace-keyed history selection
- ISSUE-006 (MEDIUM): Fixed with null promotion for missing facts

The two MEDIUM issues identified are minor UX improvements that don't block the adaptation from being production-ready.

## 第二轮复核（本轮增量）

审查范围：相对 HEAD `1c33827` 的工作区增量——图标分包回退、
`formatCodexTemplate` 与双语 `invalidJsonSyntax`、供应商删除判定合一，以及
配套单测。代码审查结论 **APPROVE**，CRITICAL/HIGH/MEDIUM 均为 0，LOW 1 条。

- 回退被确认正确：分包只是用 280 个小预载换来一个约 568KB、含约 1713 个图标的
  chunk，而刷新缺陷在同一 preview 的普通 Chrome 上同样复现；宿主 inotify 实例
  103/128、约 8292 sockets 指向宿主资源耗尽，不是应用缺陷证明。
- LOW（已采纳）：为 `formatCodexTemplate` 补 JSDoc，说明它是 Codex 目录
  `{key}` 格式化的唯一实现，以及为何不复用全局 `intl.formatMessage`。
- 审查确认供应商删除无绕过路径：`codexProviderDeleteEdits` 的唯一调用点位于
  `deleteProvider` 内，且先经过 `codexProviderDeleteBlock`；按钮禁用与写入前
  判定共用同一纯函数，符合规范「两个入口共用同一判定来源」。

对上文第一轮结论的两点更正与遗留：

1. 上文把 ISSUE-001 记为「已用 Lucide 分包部分缓解」。该缓解**已回退**，
   ISSUE-001 现按未关闭风险处理，证据与复测条件见
   [codex-adaptation-audit-2026-09-30.md](codex-adaptation-audit-2026-09-30.md)。
2. 审查提出两项不属本增量、因此未擅自改动的后续项：一是核查
   `lucide-react` 的 barrel 导入，让打包器只保留实际使用的图标，从而同时避免
   280 个 chunk 扇出与单个巨型图标 chunk；二是
   `packages/ui/src/i18n/IntlProvider.tsx` 的 `formatMessage` 逐 key
   `replaceAll`，当值本身含 `{otherKey}` 时会发生二次替换，新增的单次扫描
   实现不存在该问题。两项均已登记到审计文档的未关闭清单。

## 第三轮复核（提交 9c852a6）

代码审查结论 **REQUEST CHANGES → 修复后 APPROVE WITH NITS**：CRITICAL 0、
HIGH 1、MEDIUM 0、LOW 2。

- HIGH（已修复）：主进程崩溃恢复接线误用 `window.setTimeout`。Electron 主进程是
  纯 Node 环境，该调用会在恢复路径抛 ReferenceError，使恢复完全失效；真实日志也
  证实首版触发崩溃后进程随即退出。已改为 Node 全局 `setTimeout`，并在
  `codexRendererCrashRecovery.test.ts` 增加回归守护（对 index.ts 接线去注释后
  断言不含 `window.`），变异测试确认重新引入即失败。
- LOW（已采纳）：broker 回收的探测与 `rm` 之间存在极窄 TOCTOU，补注释说明其依赖
  Main 单实例锁收敛，且被 unlink 的服务端仍持有 inode。
- LOW（已采纳）：renderer 看门狗原先只有 4s/20s 两个固定定时器，存在检测空窗；
  改为 2s 轮询直到硬截止，React 挂载或错误面渲染后立即停止。

修复后用 CDP `Page.crash` 在真实桌面确定性验证：崩溃 → 主进程有界 reload →
`dom-ready` 且 Host 重新 attach；连续第三次崩溃时预算耗尽并明确告警
（`auto reload budget exhausted`），不进入崩溃循环。本容器 renderer 在
dom-ready 后约 0.2s 内再次崩溃（模块风暴 + inotify 耗尽），因此预算按设计用完；
资源配额正常的宿主机上首次 reload 即应恢复。

## 第四轮复核（架构边界）

架构复核结论 **APPROVE WITH NITS**，三条 NIT 全部采纳：

1. 崩溃恢复曾有两个所有者（主进程原地 reload 与 `primaryWindowCoordinator` 的
   丢弃重建），优先级未文档化，模块注释还把 macOS 写成唯一依赖 activate 的平台。
   已在 `rendererCrashRecovery.ts` 头注释与 `specs/codex-desktop-adapter.md`
   明确：原地 reload 是全平台第一道恢复，丢弃重建只是最后兜底。
2. 延迟与存活性策略原先内联在 `index.ts`。已移入策略模块（`schedule` 与
   `canReload` 可注入），`index.ts` 只提供窗口事实；新增用例覆盖延迟到期、
   窗口已消失与退出竞态三种路径。
3. 预载扇出在删除预算测试后只剩审计文档 prose。已在
   `specs/codex-desktop-adapter.md` 增加「Open renderer startup debt (not a
   gate)」一节：记录 280 个 eager `modulepreload`（227 个单图标 chunk）为未关闭
   性能债与正确方向（审计 `lucide-react` barrel 导入做 tree-shake），并明确未来
   任何预算断言必须对应真实修复可达的目标，不能把现状或巨型图标 chunk 当门槛。

## 第五轮：全表面逐操作实测 + 适配缺口修复（commit 91f830f）

在真实 Electron（隔离 QA home、loopback mock provider、CDP 9229）上对 GUI 的每个
可达表面与操作做了一遍完整 walkthrough：侧栏（分组/时间线、筛选排序、归档生命周期、
置顶、添加项目、拖拽与键盘改宽）、命令面板（空态/Actions/Tasks/Files、主题切换、
深链）、会话区（query map、复制、编辑+取消、worked-for 展开、图片预览缩放、斜杠
命令、权限模式菜单、模型选择器键盘与鼠标双路径、reasoning effort 按模型出现、
添加上下文、发送禁用态）、头部（More 菜单 11 项、Help 6 项、终端真实执行、侧栏
Review 的诚实 Git 空态）、设置页 14 个分区与 Codex 10 个子面板、配置写入的非法
JSON 拦截、中/英切换、快捷键搜索、Automations/Workflows、插件市场、手机远控
对话框、空态问候与建议 chips。全程 console error / page error 均为 0。

本轮发现并修复六个适配缺口（spec 先行，见对应 spec 增补）：

1. **Provider Base URL 无校验**：`not-a-url` 曾被直接写进原生 config.toml，
   生成运行时才会失败的坏配置。现按原生 `url::Url::parse` 口径在写入前拒绝
   （`providerBaseUrlInvalid`），实测非法值被拦截且 config 不落盘、合法值正常落盘。
2. **命令面板重复 Settings**：`suggested-settings` 与 `settings` 双注册导致任何
   搜索都出现两条同名结果；现仅保留一条（suggested 分区）。
3. **命令面板搜不到 Codex 设置**：搜 codex/provider/usage 均零结果。新增
   `Codex settings` / `Codex providers` / `Usage stats` 三条深链（仅桌面 Host
   注册，web/legacy 不显示死入口），实测直达对应分区。
4. **复制日志路径给幻影路径**：Codex 运行时不存在 legacy CLI jsonl。现解析真实
   Host 按日日志（`getAppConfigDir()/logs`），实测复制出的路径在磁盘上存在。
5. **复制任务路径给幻影路径**：Codex 线程事实源是原生 rollout + tasks-index.sqlite，
   没有 `.codez-session`。接口允许 `path: null`，菜单项禁用，实测为 [disabled]。
6. **点赞/点踩是死按钮**：原生 Codex 无逐条反馈通道，命令永远被拒后静默回滚。
   新增 `messageFeedback` 能力位（bridge 显式 unsupported，旧 peer 缺省同义），
   unsupported 时不渲染按钮，实测会话行 0 个 Like/Dislike 而 Copy/Edit/Fork 保留。

验证：bridge 单测 455 通过、ui 69 通过、desktop codex\* 55 通过、typecheck/lint(0e)/
architecture(0 violations) 全绿；真实桌面 conversation-check 10 项通过（sendTimings
399/358ms）；interaction-e2e 通过。代码审查结论 APPROVE WITH NITS（MEDIUM 为
rebase 解冲突造成的 spec 标题粘连，已修；两条 LOW 见下「审查回应」）。

### 审查回应

- MEDIUM（已采纳）：`specs/codex-desktop-adapter.md` 中 retry 一节末句与
  「Open renderer startup debt」标题粘连在同一行，已补空行。
- LOW（驳回）：建议为 `getTaskSessionFilePath` 的恒定 null 结果在 hook 层短路
  以免一次 RPC。驳回理由：该 RPC 与其余菜单路径解析共用同一 service 合同与缓存
  时机，引入「无快照概念」能力位会把运行时事实复制成第二个判定来源；菜单打开
  频次极低，收益不足以抵消合同分裂风险。
- LOW（记录）：`getTaskNativeSessionLogFile` 的 path 语义从「约定路径（可能不
  存在）」变为「存在才非 null」。现有唯一消费者（复制/禁用）已按新语义实现，
  接口 JSDoc 与 spec 已声明；未来若需展示「预期路径」应另加字段而非回退语义。

### 架构 lane 审查回应（替补审查，APPROVE WITH NITS）

首个架构 subagent 与第一次替补在本环境内均未返回（与上一轮首个架构 lane 相同的
卡死模式），最终由范围收紧的替补审查完成，结论 **APPROVE WITH NITS**，五个架构
问题（能力所有权、层界、面板单一判定源、null 安全、spec 一致性）全部通过，
`pnpm architecture:check --changed` 0 violations。两条 LOW 的处置：

- LOW（驳回）：建议把 `useCodexMessageFeedbackCapability` 与
  `useCodexDesktopFileRewindCapability` 的 `helloConversationV4` 合并为共享缓存。
  驳回理由：现有 rewind / autoReview / gitAuxiliary 三个能力 hook 均是各自独立
  hello + `bindRuntimeCapabilityRefresh` 统一刷新；引入共享缓存会新增一份缓存
  生命周期与 transport 替换失效的所有权问题，收益（每次 pane 挂载少一次本地
  hello RPC）不足以改变既有模式。
- LOW（已采纳）：在 `isCodexProviderBaseUrlValid` 补注释说明 hostname 检查是主
  防线、try/catch 只覆盖语法非法输入，避免误读 `new URL("http://")` 的引擎差异。

### 环境受限项的现场证据（probe3）

`desktop-check.mjs` 在本容器仍不能通过：runner 截图时 renderer 原生崩溃
（`page.screenshot: Page crashed`）。同一次崩溃被主进程崩溃恢复接住：日志可见
`renderer crashed; reloading window in place { reason: 'crashed', attempt: 1/2 }`
与 attempt 2，每次 reload 后 `renderer reloaded, reattached to existing host`；
预算用尽后 renderer 看门狗按设计渲染可恢复错误面（`Reload` 按钮），而不是白屏。
该证据确认恢复链路在真实崩溃下工作，但不改变「desktop-check 在本容器不记为通过」
的边界结论。
