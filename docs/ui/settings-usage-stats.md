# Settings Usage Stats

设置页 `Usage`（使用统计）分区收敛为纯本地应用用量面板（`AppUsagePanel`），不再展示特定商业套餐的剩余额度、重置卡或远端监控 Tab。

## 数据来源

- UI 只通过 `useAppUsageStats(range)` 调用 `usageStatsService.getAppUsageSnapshot({ range, timeZone })`，经 `v4/usage/stats` 获取 `AppUsageSnapshot`。
- Codex 桌面桥接模式（`packages/codex-bridge`）直接聚合 `CODEX_HOME`（默认 `~/.codex`）下的本地持久化记录：
  - `state_*.sqlite` 的 `threads` 表（会话总 Token、模型、创建与更新时间戳、rollout 路径）
  - `thread_history_*.sqlite` 的 `thread_turns` 表（各轮次耗时与会话累计时长）
  - 会话 rollout `.jsonl` 中的 `turn_context`（当前轮次模型）与 `event_msg.token_count`（精确时间戳下的 `total_token_usage` / `last_token_usage` 输入、缓存读取、缓存写入、输出、推理与总 Token 增量）
  - 当历史会话的 rollout `.jsonl` 已被清理或归档缺失时，回退使用 `threads` 表中的 `tokens_used`、`model` 与 `updated_at` 归入对应本地日期与模型，保证累计 Token 与历史活跃度不丢失。
- CLI 模式（`apps/codez-cli`）继续聚合本地 SQLite 的 `model_usage`、`turn_usage` 与 `tool_usage` 表。

## 当前展示

- 页面结构：移除顶部分区二级套餐 Tab 与 Desktop 降级占位页，直接展示四段式本地应用用量视图：
  1. 顶部全部时间累计概览指标条（累计 Token 数、峰值 Token 数、最长聊天时长、当前连续天数、最长连续天数）
  2. 52 周 Token 活动热力图（每日 / 每周 / 累计）
  3. 时间范围切换栏（`近 7 日` / `近 30 日` / `全部时间`），切换范围时清理过期 range 快照以避免短时间显示旧区间数据
  4. 每日 Token 趋势折线图（按天 × 模型）与模型用量环形图 + 排行列表
- 区域圆角：使用概览指标卡、每日 Token 趋势、模型用量分布和共享空状态统一使用 `rounded-xl`，保持主要统计模块的视觉层级一致
- Token 活动：独立提供每日、每周、累计三种范围；每日按天显示，每周按周总量显示，累计按截至当周的累计 Token 显示。范围切换使用 Hooks 范围切换同款 pill tabs，尺寸和字号对齐 task tabs（外层 `h-7`，trigger `h-6`、`text-ui-sm`）；网格固定展示最近 52 个自然周，第一行固定为周日，52 列使用 `minmax(0, 1fr)` 等分容器且不横向滚动，横纵格子间距使用 `gap-0.5`；底部月份文案锚定在每月 1 日所在的周列，最多只显示最后 12 个有效月份文案，多出的起始月份段保留网格占位但文字留空，因此当前年度周期显示为去年 9 月到今年 8 月，后续按年份自然递进；每周和累计 hover 任意格时高亮整列，tooltip 锚定整列；tooltip 使用两行结构，第一行展示日期/周范围，第二行展示 Token 数和消息轮数，容器使用 `rounded-xl`
- 每日 Token 趋势图：默认展示近 7 日，可切换近 30 日或全部时间；连续补齐空白日期后展示模型 Token 折线；Y 轴上限按实际展示的模型折线单点峰值计算，不使用同日所有模型总量，也不计入未展示模型，避免非堆叠折线被总量范围压缩；Tooltip 顶部总量和每个 Model 的值都使用本地化紧凑 Token 单位（中文万/亿、英文 K/M/B，并带 `tokens`），避免模型明细显示无量纲的长裸数字；Tooltip 数字使用等宽字体保证对齐，`tokens` 单位使用 UI Sans 和弱化文字色，不能继承 `font-mono`；时间范围 tabs 使用 pill 样式，尺寸对齐 task tabs（外层 `h-7`，trigger `h-6`、`text-ui-sm`）
- 模型用量图：按模型聚合 Token，以环形饼图展示占比；超过 6 个分区时合并为“其他模型”，配色复用趋势图的 `--color-usage-chart-*` token；右侧模型列表除展示总 Token 与占比外，当存在输入/输出/缓存读取明细时以副行紧凑展示（输入 / 缓存 / 输出）；手机端维持 224px 图形高度并纵向排列，桌面端图形区与明细区各占一半，图形高度提升到 256px、最大宽度 288px，并相对右侧明细整体垂直居中
