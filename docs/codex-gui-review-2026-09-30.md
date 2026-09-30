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

### 环境受限项的现场证据（probe3）

`desktop-check.mjs` 在本容器仍不能通过：runner 截图时 renderer 原生崩溃
（`page.screenshot: Page crashed`）。同一次崩溃被主进程崩溃恢复接住：日志可见
`renderer crashed; reloading window in place { reason: 'crashed', attempt: 1/2 }`
与 attempt 2，每次 reload 后 `renderer reloaded, reattached to existing host`；
预算用尽后 renderer 看门狗按设计渲染可恢复错误面（`Reload` 按钮），而不是白屏。
该证据确认恢复链路在真实崩溃下工作，但不改变「desktop-check 在本容器不记为通过」
的边界结论。
