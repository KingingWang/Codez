import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const workflow = await readFile(
  new URL("../../.github/workflows/issue-ai.yml", import.meta.url),
  "utf8",
);
const script = workflow
  .match(/name: Rate limit check[\s\S]*?script: \|\n([\s\S]*?)(?=\n {6}- name:)/)?.[1]
  .replace(/^ {12}/gm, "");
assert.ok(script, "Rate limit check 必须保留可执行的 github-script");

const now = Date.parse("2026-10-18T13:40:00Z");
const runId = 9999;

async function checkRate(priorCount, includeCurrent = true) {
  const outputs = {};
  const notices = [];
  let query;
  const listWorkflowRuns = () => {};
  const runs = Array.from({ length: priorCount }, (_, index) => ({ id: index + 1 }));
  if (includeCurrent) runs.push({ id: runId });

  await runInNewContext(`(async () => { ${script} })()`, {
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    context: { repo: { owner: "owner", repo: "repo" }, runId },
    github: {
      rest: { actions: { listWorkflowRuns } },
      paginate: async (method, options) => {
        assert.equal(method, listWorkflowRuns);
        query = options;
        return runs;
      },
    },
    core: {
      setOutput: (name, value) => {
        outputs[name] = value;
      },
      notice: (message) => notices.push(message),
    },
  });

  return { outputs, notices, query };
}

test("按滚动 24 小时分页查询，仅统计自动 issues 运行", async () => {
  const { query } = await checkRate(0);
  assert.equal(query.owner, "owner");
  assert.equal(query.repo, "repo");
  assert.equal(query.workflow_id, "issue-ai.yml");
  assert.equal(query.event, "issues");
  assert.equal(query.created, ">=2026-10-17T13:40:00.000Z");
  assert.equal(query.per_page, 100);
});

for (const includeCurrent of [true, false]) {
  test(`历史 29 次时放行第 30 次，查询${includeCurrent ? "包含" : "不包含"}当前运行`, async () => {
    const { outputs, notices } = await checkRate(29, includeCurrent);
    assert.equal(outputs.allow, "true");
    assert.match(notices[0], /last 24 hours: 29 \(limit 30\)/);
  });

  test(`历史 30 次时拦截第 31 次，查询${includeCurrent ? "包含" : "不包含"}当前运行`, async () => {
    const { outputs, notices } = await checkRate(30, includeCurrent);
    assert.equal(outputs.allow, "false");
    assert.match(notices[0], /last 24 hours: 30 \(limit 30\)/);
  });
}

function readPrompt(jobName) {
  const job = workflow.split(`\n  ${jobName}:\n`)[1]?.split(/\n {2}[\w-]+:\n/)[0];
  const prompt = job
    ?.match(/^ {10}prompt: \|\n((?: {12}[^\n]*(?:\n|$)|\n)+)/m)?.[1]
    .replace(/^ {12}/gm, "")
    .trim();
  assert.ok(prompt, `${jobName} 必须有独立的 prompt`);
  return prompt;
}

const autoPrompt = readPrompt("auto-triage");
const manualPrompt = readPrompt("manual");

test("自动初筛和手动追问各有单一任务，不复用同一提示词", () => {
  assert.notEqual(autoPrompt, manualPrompt);
  assert.match(autoPrompt, /唯一目标.*定位本次 Issue/);
  assert.match(manualPrompt, /唯一目标.*回答本次追问/);
  assert.match(manualPrompt, /重新核验已有评论.*增量/);
});

test("两个入口禁用内置写入工具，不提升 GitHub 权限或持久化凭据", () => {
  const permissions = workflow.match(/^permissions:\n((?: {2}[^\n]+\n)+)/m)?.[1];
  assert.ok(permissions);
  assert.match(permissions, /contents: read/);
  assert.match(permissions, /pull-requests: read/);
  assert.match(permissions, /issues: write/);
  assert.equal(workflow.match(/persist-credentials: false/g)?.length, 2);

  for (const jobName of ["auto-triage", "manual"]) {
    const job = workflow.split(`\n  ${jobName}:\n`)[1]?.split(/\n {2}[\w-]+:\n/)[0];
    const permissionJson = job?.match(/OPENCODE_PERMISSION: '([^'\n]+)'/)?.[1];
    assert.ok(permissionJson, `${jobName} 必须在工具层禁用内置写入能力`);
    assert.deepEqual(JSON.parse(permissionJson), { edit: "deny" });
  }
});

for (const [name, prompt] of [
  ["自动初筛", autoPrompt],
  ["手动调查", manualPrompt],
]) {
  test(`${name}限制文件、Git、远端副作用，并只由工作流发表评论`, () => {
    assert.match(prompt, /不要修改任何文件/);
    assert.match(prompt, /git add、git commit、git push/);
    assert.match(prompt, /不要创建分支或 Pull Request/);
    assert.match(prompt, /标签、指派.*状态/);
    assert.match(prompt, /最终回复由工作流发布为一条评论/);
    assert.match(prompt, /不要通过 gh\/API 另发评论/);
    assert.match(prompt, /待核实的数据.*不能.*覆盖/);
  });

  test(`${name}要求完整上下文、真实缺陷和端到端证据`, () => {
    assert.match(prompt, /完整上下文/);
    assert.match(prompt, /事实、推测、未验证/);
    assert.match(prompt, /明确.*契约/);
    assert.match(prompt, /可选增强.*不.*缺陷/);
    assert.match(prompt, /保护逻辑.*不等于端到端正确/);
    assert.match(prompt, /证据.*影响.*最小验证/);
    assert.match(prompt, /提交.*文件.*行号/);
  });

  test(`${name}区分读过与执行过测试，不编造命令或运行结果`, () => {
    assert.match(prompt, /读过测试.*执行过测试/);
    assert.match(prompt, /实际断言/);
    assert.match(prompt, /依赖.*不写文件.*真实服务.*额度/);
    assert.match(prompt, /命令.*package\.json/);
    assert.match(prompt, /未执行.*原因/);
  });

  test(`${name}自行查明可检索事实，只询问真正阻塞的问题`, () => {
    assert.match(prompt, /自行查明.*不要.*提交者/);
    assert.match(prompt, /最多 3 个.*阻塞/);
    assert.match(prompt, /不要.*扫描过程/);
  });
}

test("自动初筛有简短无发现出口，证据不足不能宣称实现正确", () => {
  assert.match(autoPrompt, /未发现实现缺口且无关键未验证风险/);
  assert.match(autoPrompt, /初步结论：静态核查暂未发现需要修改的实现缺口。/);
  assert.match(autoPrompt, /最多 2 条.*证据.*结束/);
  assert.match(autoPrompt, /证据不足.*待复现/);
  assert.match(autoPrompt, /1500 字/);
  assert.match(autoPrompt, /最多 3 条发现/);
});

test("手动调查增量交接而非修复，无新增发现不重复旧报告", () => {
  assert.match(manualPrompt, /修复.*转为.*实施交接.*不要实际修改/);
  assert.match(manualPrompt, /未发现新增证据或新的已确认缺口/);
  assert.match(manualPrompt, /只有.*无关键未验证风险.*没有旧结论/);
  assert.match(manualPrompt, /不能把调查不足当成没有问题/);
  assert.match(manualPrompt, /不要重复.*旧报告/);
  assert.match(manualPrompt, /## 实施交接/);
  assert.match(manualPrompt, /3000 字/);
});
