# Codex 设置 QA UI Fixtures

TS/TSX 文件提供隔离 React fixture、合成配置/模型与 mock service ports。
它们是真实 UI 层；Node/Vite/Playwright 和 desktop probe 的 IO 生命周期归独立 QA adapter。
fake ports 不读取真实 Provider Key、不发送实际模型请求、不打开外部页面。

原 fixture host 是合成事实的唯一来源，UI 只驱动现有组件、展示投影和本次验收 probe。
automation、catalog、provider、approval、history、project discovery、title-model、usage
和 subagent 输入沿用各自真实产品接口，不在 fixture 中修复产品状态。

contract 导出 mock 组装需要的原公开服务类型。不得通过把 TSX 标为 adapters
规避 UI 端口边界；服务类型应由本 contract 进入。
