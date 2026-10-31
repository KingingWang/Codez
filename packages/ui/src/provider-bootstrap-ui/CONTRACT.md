# Provider 启动展示

Host systemService.info 提供真实 agentRuntimeMode，Root 只读该结果选择既有启动展示。
查询期间是 pending；缺失能力/读取失败保持原 legacy 行为，不从构建时间或 Agent 代际猜测。
service 切换、卸载和新 Root scope 撤销旧响应，不让旧 Host 结果启动新 Host 的 Provider 路径。

legacy OAuth/session 恢复继续原 Root owner，不创建账号事实、自动登录流程或后台轮询器。
contract 公开原 system info port，例子不启动 Provider 或执行登录。
