# Lexical IME 浏览器 Fixture

既有独立页面的 Lexical editor 与 probe 是本次 QA 输入状态唯一 owner。
UI fixture 捕获 composition/input/update 与 Enter 提交次数，不连接产品 Host、保存聊天或
生成真实任务。composing 的 Enter 不提交；卸载清除 listener。

该页面确实是 UI，不伪标成 IO adapter。contract 只描述浏览器验收的观察面；
例子不挂载页面或操作原生输入。保留原 HTML/页面入口和既有浏览器验收。
