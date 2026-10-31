# 第三方许可补录：保持阻断的缺口（2026-10-31）

分支 `integration/upstream-3.17.1-20261031`。本轮 13 个 `Missing complete upstream notices`
缺口中，11 个已用与版本绑定的权威原文关闭（6 个 `@crowecawcaw/xa11y-*@0.15.0`、
4 个 `@nut-tree-fork/*@4.2.6`、`readable-web-to-node-stream@3.0.4`）。
以下 2 个包**取不到与版本绑定的权威原文，按 SPEC 保持阻断**，未使用标准许可模板、
未按 author 推断、未写 `acceptedMissingNotice`、未改校验逻辑。

因此 `node scripts/licenses.mjs notices` 仍失败，`THIRD-PARTY-NOTICES.md` 与
`third-party/inventory.json` 未重生成；`node scripts/licenses.mjs check` 继续报
`Third-party notices changed; regenerate the inventory`。

---

## 1. `buffer-equal@0.0.1`

生产路径：`@nut-tree-fork/nut-js@4.2.6` → `jimp@0.22.x` → `load-bmfont@1.4.2` → `buffer-equal@0.0.1`
（`pnpm-lock.yaml:23118-23120`）。实装位置 `node_modules/buffer-equal`。

### 实际缺口

包内只有 `.travis.yml`、`README.markdown`、`example/eq.js`、`index.js`、`package.json`、
`test/eq.js`。没有 LICENSE / LICENCE / COPYING / NOTICE / COPYRIGHT。
`README.markdown` 的 `license` 段正文只有 `MIT` 三个字母（`readPackageNotices` 提取到
21 字节的 license section，不构成完整许可文件，且无版权行）。
`index.js` 无许可或版权头。`package.json` 只声明 `"license": "MIT"`，无 `gitHead`
（发布时 `_npmVersion` 1.4.3）。

### 已尝试的来源

| 来源                                                                                                          | 结果                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------- |
| registry `dist.tarball`（`https://registry.npmjs.org/buffer-equal/-/buffer-equal-0.0.1.tgz`）                 | 已下载，`dist.shasum` 91bc74b11ea405bc916bc6aa908faafa5b4aac4b 与 registry 一致；成员仅 6 个，无任何许可文件                                                                              |
| registry 该版本元数据                                                                                         | `gitHead` 为 null；`repository` = `git://github.com/substack/node-buffer-equal.git`                                                                                                       |
| `github.com/substack/node-buffer-equal`                                                                       | HTTP 404 / `git ls-remote` "Repository not found"（上游已删除）                                                                                                                           |
| `github.com/inspect-js/buffer-equal`（npm 自己为 `buffer-equal@1.0.1` 登记的 repository，保留完整历史与 tag） | tag `v0.0.1` = `7d08354dacc491b6af3e96fad65fd66786fddfc4`（2014-05-24，James Halliday，"0.0.1"）。该 revision 全树逐文件 grep `copyright                                                  | permission is hereby | licen[sc]e`只命中`README.markdown:59`的`license`标题与`package.json:27`的`"license": "MIT"`，**无任何许可原文** |
| GitHub 仓库搜索 `node-buffer-equal in:name`                                                                   | 仅 `n074v41l4bl34u/node-buffer-equal`（2013 年快照，早于 0.0.1 发布，非权威）与 `deepin-community/node-buffer-equal`（Debian 重打包，NOASSERTION，2023）；均不能作为 0.0.1 的版本绑定原文 |

### 最接近但不满足「版本绑定」的材料（未采用）

LICENSE 文件由 `a7326b2a0b34b98ba0d4d63cb126357175244847`（2016-01-01，
James Halliday <mail@substack.net>，"add license file"）首次加入，
**该 commit 正是 `buffer-equal@0.0.2` 的 npm gitHead**；tag `v0.0.2` 起才包含 LICENSE。
即上游的许可原文绑定的是 0.0.2，不是 0.0.1，晚于 0.0.1 发布（2014-05-25）约 19 个月。
该文本 sha256 `435a6722c786b0a56fbe7387028f1d9d3f3a2d0fb615bb8fee118727c3f59b7b`，
正文为 "This software is released under the MIT license:" + MIT 全文，
**不含任何版权行**（即使采用也无法补出权利人）。
URL：`https://raw.githubusercontent.com/inspect-js/buffer-equal/a7326b2a0b34b98ba0d4d63cb126357175244847/LICENSE`
（`HEAD` 上的 LICENSE 已再次变更，sha256 `6d3120a0e61bae9e748de83e07ac79bda912ab8444e0a1e3d01fa4d9dd6bc0aa`）。

### 需要什么才能关闭

三选一，且都需要维护者显式决定，不能由本次补录自行放宽：

1. 取得发布方（James Halliday / inspect-js 维护者）对 0.0.1 适用其 MIT 许可原文的书面确认，
   然后把上述 `a7326b2` 的 LICENSE 快照进 `third-party/upstream/<sha256>.txt`，
   在 `npm-overrides.json` 登记 `source` / `referenceRevision` / `evidence`，
   并在 evidence 中明确写清「该原文来自 0.0.2 的 gitHead，晚于 0.0.1，凭发布方确认适用」。
2. 走仓库既有的 `evidenceKind: "publisher-license-identifier-and-standard-terms"` 登记路径
   （如 `@electron-internal/extract-zip@1.0.5`）：`notices` / `check` 基础门禁可通过，
   但该包继续留在 `inventory.json` 的 `reviewRequired`，`check --strict` 仍失败。
   本轮任务明确禁止使用标准许可模板，故未执行。
3. 把 `buffer-equal@0.0.1` 移出生产图（例如升级 `load-bmfont` / `jimp`，
   `buffer-equal@1.0.1` 包内自带 LICENSE）。这会改 `package.json` 与 lockfile，
   超出本次「只改 `third-party/**`」的授权范围。

---

## 2. `tr46@0.0.3`

生产路径：`node-fetch@2.7.0` / `isomorphic-fetch@3.0.0` → `whatwg-url@5.0.0` → `tr46@0.0.3`
（`pnpm-lock.yaml:27404`）。实装位置为嵌套目录
`node_modules/node-fetch/node_modules/tr46` 与 `node_modules/isomorphic-fetch/node_modules/tr46`
（顶层 `node_modules/tr46` 是 6.0.0，自带 `LICENSE.md`，与本缺口无关，不得混用）。

### 实际缺口

包内只有 `index.js`、`lib/.gitkeep`、`lib/mappingTable.json`、`.npmignore`、`package.json`。
**没有 LICENSE，也没有 README**，`index.js` 无许可或版权头。
`package.json` 只声明 `"license": "MIT"` 与 `author: Sebastian Mayr <npm@smayr.name>`；
`repository` = `git+https://github.com/Sebmaster/tr46.js.git`（现已转移到 `jsdom/tr46`）。
因此 `readPackageNotices` 对该目录返回 0 条材料——连 README 许可段都没有。

### 已尝试的来源

| 来源                                                                          | 结果                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| registry `dist.tarball`（`https://registry.npmjs.org/tr46/-/tr46-0.0.3.tgz`） | 已下载，`dist.shasum` 8184fd347dac9cdc185992f3a6622e14b9d9ab6a 与 registry 一致；成员仅 5 个，无许可文件、无 README                                                                                                                                                                                                                                                                                                             |
| registry 该版本元数据                                                         | `gitHead` = `a8009f9ce80ff5dbe71dd71e203afe4e4c878d28`；发布时间 2016-01-20T02:08:54Z                                                                                                                                                                                                                                                                                                                                           |
| `github.com/Sebmaster/tr46.js`（→ `jsdom/tr46`）                              | tag `0.0.3` 正好指向 `a8009f9ce80ff5dbe71dd71e203afe4e4c878d28`（2016-01-20，Sebastian Mayr，"0.0.3"），与 npm gitHead 逐字符一致。该 revision 全树为 `.gitignore`、`.npmignore`、`index.js`、`lib/.gitkeep`、`package.json`、`scripts/generateMappingTable.js`、`scripts/getLatestUnicodeTests.js`、`test/unicode.js`、`test/unicode/.gitkeep`；逐文件 grep 只命中 `package.json:22` 的 `"license": "MIT"`，**无任何许可原文** |
| 全历史 `git log --all --diff-filter=A` 过滤许可路径                           | 仓库史上只新增过一次 `LICENSE.md`：`3a6f29721e7063b9ffd421e461a54beae6170001`（2016-08-02，Sebastian Mayr <sebmaster16@gmail.com>，"Add MIT license"）                                                                                                                                                                                                                                                                          |

### 最接近但不满足「版本绑定」的材料（未采用）

`3a6f2972` 的 `LICENSE.md`（"The MIT License (MIT) / Copyright (c) Sebastian Mayr" + MIT 全文），
sha256 `eeed1ca176eebad5c73870e233cfff03981fecd319c969475dfa3633036c336b`。
它晚于 0.0.3 tag（2016-01-20）约 6.5 个月，且**不是任何已发布 npm 版本的 gitHead**
（0.0.3 → `a8009f9`；下一个版本 1.0.0 发布于 2017-07-27）。
仓库现行 `main` 上的 `LICENSE.md` 又是另一份文本，
sha256 `499d6d466d064e0460427967a344e2a32fcb86ea8c6cd1a285ec4f1fa03fba67`
（与实装 `tr46@6.0.0` 的 `LICENSE.md` 相同），更不能套用到 0.0.3。
URL：`https://raw.githubusercontent.com/jsdom/tr46/3a6f29721e7063b9ffd421e461a54beae6170001/LICENSE.md`

仓库已有先例支持不套用：`third-party/README.md` 对 react-best-practices 的处理是
「固定参考 revision 声明 MIT 但树中无完整 LICENSE 文件 → 保留本地署名、不编造上游版权年份或许可证原文、
继续留在 reviewRequired」；`@dukelib/sheets-wasm@0.1.21` 的 evidence 则明确要求
"License from the exact upstream release tag"。

### 需要什么才能关闭

三选一，同样需要维护者显式决定：

1. 取得发布方（Sebastian Mayr / jsdom 维护者）确认 `3a6f2972` 的 MIT 原文适用于 0.0.3，
   然后按上述 URL 快照进 `third-party/upstream/<sha256>.txt` 并登记
   `source` / `referenceRevision` / `evidence`（evidence 必须写清该原文晚于 0.0.3 tag、
   凭发布方确认适用，不冒充 0.0.3 自带文件）。
2. 走既有 `evidenceKind: "publisher-license-identifier-and-standard-terms"` 登记路径；
   注意该包连 README 许可段都没有，登记后 `reviewRequired` 的说明比其它同类条目更弱，
   `check --strict` 仍失败。本轮任务禁止使用标准许可模板，故未执行。
3. 把 `tr46@0.0.3` 移出生产图（例如让 `node-fetch` / `isomorphic-fetch` 升级到使用
   `whatwg-url@>=6` 的版本，`tr46@>=1.0.0` 包内自带 `LICENSE.md`）。
   这会改 `package.json` 与 lockfile，超出本次授权范围。

---

## 与既有文档的冲突（需 root 决定，本轮未改）

`specs/computer-use-open-replacement.md:349` 记载 2026-09-23 曾把这 7 个包
（4 个 nut-tree-fork + buffer-equal + readable-web-to-node-stream + tr46）一次性钉完，
并称 `check` 通过（1829 个实装包，退出码 0）。两点与本轮实测不符：

1. 它称「nut-tree/fork 仓库在 GitHub 已不可公开访问（404），故采用发行方 SPDX 声明
   - canonical 许可文本（source 指向 apache.org）」。本轮找到了真实发布仓库
     `github.com/ZachJW34/nut.js`（根 manifest `@nut-tree-fork/monorepo` 4.2.6），
     tag `v4.2.6` = `0bcbcdc6d080c0fe007b8000a3915d4461a7685d`，
     其 `core/nut.js/LICENSE` 与实装 `@nut-tree-fork/nut-js@4.2.6` 及
     `@nut-tree-fork/libnut-linux@2.7.5` 包内 LICENSE **逐字节一致**
     （sha256 `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`）。
     本轮因此用真实上游原文替代 canonical 文本，不再需要 apache.org 兜底。
     404 的原因是 org 名不是 `nut-tree-fork`（该 org 在 GitHub 不存在），
     发布者是 npm 维护者 `zachjw34` 对应的 `ZachJW34`。
2. 它称 buffer-equal / tr46 也「钉上游仓库 LICENSE/README 许可段」。本轮实测这两个包
   在其**版本对应 revision** 上没有任何许可原文（见上），若此前确实钉过，
   用的必然是更晚 revision 的文本或标准模板；那属于把非版本绑定材料当成版本绑定材料，
   本轮不复制该做法。该 spec 段落需要 root 更正或明确记为例外。

`specs/` 不在本轮授权范围（只允许改 `third-party/**`），故未改动。
