# Codex 辅助对话（selection side chat）

## Outcome

Codex 运行时（codex-bridge）支持 `createSelectionSideSession`：右侧面板「辅助对话」、会话划词「在辅助对话中提问」、Markdown 预览划词、`/side`、`/btw` 五个入口都能创建隐藏子会话并在右侧标签打开。语义与 legacy codez-cli 运行时（`apps/codez-cli/.../session-fork.ts` 的 `selection_side_chat`）对齐：child 继承父会话已落盘历史作为模型参考上下文，但不在 UI 展示继承历史；child 不出现在左侧任务列表。

## 语义与所有权

- child 的唯一事实所有者是原生 Codex 线程；bridge 不引入任何本地持久化文件。
- 创建：`thread/fork { threadId: <parent>, threadSource: "codez_selection_side_chat" }`，不截断（继承全量历史）。fork 保留源 turn id，且 fork 后线程立即可 `turn/start`。
  - `threadSource` 是原生 rollout 持久化字段（`SessionMeta.thread_source`），`Feature(String)` 变体接受任意字符串并原样回读；bridge 用它作为「这是辅助对话 child」的标记，重启后仍可识别。显式 fork（`forkAssistant`）不携带该标记，不受影响。
- 任务列表隐藏：bridge `projectSessionsIndex` 过滤 `threadSource === 标记` 的线程。不用原生 `thread/archive`——归档是用户可见语义，且归档会级联归档后代线程。
- 继承历史裁剪：`ThreadStateStore.load()` 发现线程带标记且有 `forkedFromId` 时，lock-free 读父线程 turns（`thread/turns/list`），把「turn id 同时存在于父」的 turn 记入 `state.sideChat.inheritedTurnIds`；`projectThread` 投影时跳过这些 turn。父读取失败（删除/跨 workspace）fail-open 不裁剪。父之后新增/revert turn 不影响 child 裁剪集合（fork 后 child 不再获得父 turn；id 不在集合里的 turn 一律展示）。
- 边界指令：child 的第一条自有输入（创建命令的 `firstInput`，或之后对该 child 的首条 `sendText`）由 bridge 在文本前拼接边界指令（与 legacy `SELECTION_SIDE_CHAT_BOUNDARY` 同文案：继承历史仅供参考、不自动继续父工作）。判定「尚无自有输入」= 当前 turns 全部属于 inheritedTurnIds。指令只进模型上下文；UI 裁剪按 turn 归属判定，不解析文本。
- `firstInput.modelSelection` 存在时经 `selectionOverrides` 随首个 `turn/start` 下发；缺省继承父线程原生设置。
- writer-conflict 只读父会话允许创建（fork 不取源写锁，与 `forkAssistant` 同一逃生通道）。

## 事件顺序

```text
UI dispatch createSelectionSideSession(parent)
  → bridge: thread/fork(parent, threadSource=marker)
  → store.markStarted(child) + reloadAfterHistoryChange(child)   // 完整 load，含裁剪集合
  → firstInput?  → child turn/start(指令 + text)（只落 child，不进父 queue）
  → ACK accepted { sessionId: childId }
  → UI 打开右侧 selection-side-chat tab → v4 订阅 child → snapshot 只含 child 自有 turns
```

## 失败语义

- 任一原生请求失败 → ACK `failed / codex.commandFailed`，`message` 携带原生错误；不产生半注册 child（fork 失败即整体失败；fork 成功但首个 turn/start 失败时 child 仍存在，用户重试发送即可——与 legacy 「child 先注册、首输入失败可重发」语义一致）。
- UI 创建失败必须可见：ACK 的 `message`（而非仅 `reasonCode`）进入错误提示，不再只写日志。
- 复用既有 child 的存活探测（`session/read`）在 bridge 下的「不存在」错误文案与 legacy `sessionNotFound` 不同，UI 判定需同时覆盖两种签名。

## 验收

- 五个入口在 Codex 运行时下创建 child 并打开右侧标签；左侧任务列表不出现 child。
- child 副屏只显示 fork 之后自有 turn；划词引用经 UI 本地事件落入 child composer。
- 首个模型请求（mock provider 观察）正文以边界指令开头。
- 应用重启后 child 仍可打开、仍隐藏于任务列表、仍裁剪继承历史（load 冷路径）。
- `pnpm typecheck`、`pnpm lint`、bridge 单测通过。
