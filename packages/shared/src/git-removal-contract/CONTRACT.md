# Git 安全移除请求

精确登记 `gitRemoval.ts` 的既有请求、预览和结果类型。依赖 shared 的 GitFileChange，
不执行 Git/IO，不拥有工作树、分支、运行实例或操作台账。

preview 的 operationId、statusFingerprint 与 remove 的明确丢弃意图贯穿既有服务端
复检；结果未知按原 operationId 对账，明确失败重新预检。分支删除携带 expected commit，
由既有 Git adapter 原子比较；UI 的确认和路径不是删除授权。

依据：[工作树移除](../../../../specs/git-worktree-removal.md)、
[工作树项目](../../../../specs/git-worktree-projects.md)。
