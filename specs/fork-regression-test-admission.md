# Fork 既有回归的精确准入与执行

## 范围与所有者

本规格落实 [上游集成合同](upstream-main-integration.md) 的定制回归例外，不恢复一般 App
单测制度，不新增 App `test/spec` 或 `contract.test.ts`，不把业务测试加入工程 Vitest 名单，
也不把回归通过自动升级为 E2E 覆盖。

`scripts/fork-regression-test-files.json` 是唯一准入名单。它只登记本次迁移前已经存在、
曾被本地定制提交触碰的 App 回归；新的模块治理夹具不因目录或名字相似而获得准入。
Bridge、CLI、CUA、桌面 E2E 与浏览器验收继续使用各自入口，不属于 `test:fork`。

## 历史来源与框架分流

- 固定旧重命名基准：`c0695b7f01ad057ff92fd0dca3c5e2df1711f8ba`。
- 固定原最终树：`3eafe4fe962b5824ecf2e69392f69900ba19d51d`。
- 使用基准至原最终树之间的逐提交路径并集，再与原最终树交集；不能只取最终净差异，
  否则会漏掉修改后复原的既有回归。
- 仅登记 `packages/` 下的测试文件，排除 Codex bridge、CUA、E2E 和浏览器验收。
- 历史 `*.e2e.test.*` 即使位于普通 `test/` 目录，也单独记录为 `standaloneE2e`，
  不因使用 Node runner 而混入普通 Node 回归清单。
- 已属于 `scripts/engineering-test-files.json` 的文件单独记录为既有工程证据；不改该名单。
- 其余文件按原最终树源码分流：沿用 `unit-test-frameworks.mjs` 的直接 `node:test` import
  判定，Node 文件按所属包路径分组；剩余既有 Vitest 文件组成 `test:fork` 精确名单。
- 路径和分组稳定排序、跨分类唯一；生成结果记录完整 Git SHA，不保存测试通过状态。

生成器是维护工具，读取 Git 历史和现有工程名单，不 stage、commit 或改变测试源码。
日常执行只读取已登记 JSON，不要求浅克隆持有旧提交；没有历史时不能臆造或扩大名单。

## 执行合同

`pnpm test:fork <文件...>` 必须显式指定一个或多个已登记 Vitest 文件：

1. 把输入规范化为仓库相对路径，并去重。
2. 拒绝目录、glob、未登记测试、Node/tsx 测试、工程测试和可覆盖配置的 CLI 选项。
3. 检查所选文件存在，再通过固定 `vitest.fork.config.ts` 启动 Vitest。
4. 没有文件、文件尚未重放或准入失败时在启动 Vitest 前失败；不得回落到完整套件。
5. 返回真实子进程退出码；选择成功不等于测试通过。

`vitest.fork.config.ts` 的 `include` 直接读取同一 JSON 的 Vitest 分类，不保留 App 通配符。
Node 分类仅提供精确所属包文件清单，使用所属包的 Node/tsx 入口单独执行，不能送入 Vitest
后以空 suite 或未选中宣称通过。

上游根 Vitest 继续只管理工程项目。当前自研 CUA 使用包内 `node --test`，删除不存在的
CUA Vitest 配置引用；CLI 的已不存在测试只清理命令引用，不恢复文件。

## 维护命令与验收

- `node scripts/generate-fork-regression-tests.mjs --check`：有旧历史的维护环境复核名单；
  无历史时明确失败，不作为所有浅克隆都必须执行的门禁。
- `node scripts/generate-fork-regression-tests.mjs --write`：按固定来源重新生成名单。
- `node --test scripts/test/fork-regression-test-admission.test.mjs`：只验证工程选择器与历史
  分类规则，不导入或执行 App 回归。

工程回归覆盖逐提交触碰后复原、原最终树缺席、框架分流、工程/CLI/CUA/E2E 排除、
跨分类重复、稳定分组、空参数、目录/glob/未登记拒绝、Node/工程误送拒绝、精确去重、
固定 Vitest 配置与退出码保留。

保留现行覆盖矩阵的 `retired:` provenance。名单不增加新的证据标签，也不放宽 retired
checker；真实 fork 执行结果单独记录于集成报告，未运行的 App、GUI 或 E2E 如实注明。
