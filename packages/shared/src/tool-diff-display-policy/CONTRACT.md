# 工具 Diff 预览预算

精确登记 `toolDiffDisplayLimits.ts` 的两个现有常量；纯 contract，无 IO、缓存或写入路径。
预算只限制卡片预览的 hunk/行展示，不修改原工具结果、原生历史、附件或完整 Diff。
它不替代 bridge projection 的类型化行预算错误或有界历史读取。

依据：[原生 thread items](../../../../specs/codex-desktop-thread-items.md)、
[上游集成](../../../../specs/upstream-main-integration.md)。
