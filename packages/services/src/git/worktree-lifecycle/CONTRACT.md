# Git worktree lifecycle

GitCliRepo/原 command port 持有仓库操作；原 operation record/锁承担创建和删除的
幂等边界。本模块精确登记六个 helper，不接管整个 Git service 或新建 Repo owner。

```text
只读 preview → 原用户确认/fingerprint → operationId + 原锁
                                               ↓
                           仓库/引用复验 → 原 Git 命令 → 原记录/结果
```

- 创建继续校验目录、分支、仓库身份和原幂等 operationId；不复用其他 workspace 的记录。
- 删除前重新检查 worktree、dirty/attention、HEAD 可达性与 preview fingerprint；预览缺失或扫描不完整不得成功删除。
- 分支删除保留当前分支/所有 worktree 占用保护以及 expectedCommitHash 的引用 CAS。
- removal record 和 scan 是内部实现；UI 只调用现有 Git service/hook，不直接导入这些文件。
- 原锁、native Git 顺序和失败恢复不因登记变成第二套超时/重试兜底。
- desktop/mobile 仍通过所属 Host/身份访问原端口；不以本机路径代替远端 identity。
