# Artifact 图片预览缓存

原 artifactImageCache 的单一 Map 唯一持有 objectURL、大小和 LRU 回收。调用方命中后不得
revoke；替换、逐出与显式清空由该缓存完成。现有预算为 24 项、48 MiB。

缓存按既有 session/ref 内容引用工作，只跨同内容的 React 重挂复用，不写磁盘或
会话业务状态。URL 释放是浏览器资源 IO，因此该模块属于 adapters，不标为 domain。
contract 与例子仅描述已有 get/cache/clear 端口，不创建第二份缓存。
