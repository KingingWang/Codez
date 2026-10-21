import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { extractOpenCodeText, isExplicitCommand } from "../../.github/scripts/issue-ai.mjs";

const workflow = await readFile(
  new URL("../../.github/workflows/issue-ai.yml", import.meta.url),
  "utf8",
);
const autoPrompt = await readFile(
  new URL("../../.github/issue-ai/auto-prompt.md", import.meta.url),
  "utf8",
);
const manualPrompt = await readFile(
  new URL("../../.github/issue-ai/manual-prompt.md", import.meta.url),
  "utf8",
);
const admissionScript = workflow
  .match(/id: admission[\s\S]*?script: \|\n([\s\S]*?)(?=\n {2}auto-triage:)/)?.[1]
  .replace(/^ {12}/gm, "");
assert.ok(admissionScript, "admission 必须保留可执行的 github-script");

const now = Date.parse("2026-10-18T13:40:00Z");
const runId = 9999;

async function runAdmission({
  eventName = "issues",
  payload = {
    action: "opened",
    issue: {},
    sender: { type: "User" },
  },
  limit = "",
  attempt = "1",
  runsByEvent = {},
  jobsByRun = {},
}) {
  const outputs = {};
  const notices = [];
  const queries = [];
  let failed;
  const listWorkflowRuns = () => {};
  const listJobsForWorkflowRun = () => {};

  await runInNewContext(`(async () => { ${admissionScript} })()`, {
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    process: {
      env: {
        ISSUE_AI_DAILY_LIMIT: limit,
        GITHUB_RUN_ATTEMPT: attempt,
      },
    },
    context: {
      eventName,
      payload,
      repo: { owner: "owner", repo: "repo" },
      runId,
    },
    github: {
      rest: {
        actions: {
          listWorkflowRuns,
          listJobsForWorkflowRun,
        },
      },
      paginate: async (method, options) => {
        queries.push({ method, options });
        if (method === listWorkflowRuns) {
          return runsByEvent[options.event] ?? [];
        }
        assert.equal(method, listJobsForWorkflowRun);
        return jobsByRun[options.run_id] ?? [];
      },
    },
    core: {
      setOutput: (name, value) => {
        outputs[name] = value;
      },
      notice: (message) => notices.push(message),
      setFailed: (message) => {
        failed = message;
      },
    },
  });

  return { outputs, notices, queries, failed };
}

function acceptedRuns(count, start = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: start + index,
  }));
}

function acceptedJobs(runs) {
  return Object.fromEntries(
    runs.map((run) => [run.id, [{ name: "admission", conclusion: "success" }]]),
  );
}

test("默认额度为 30，查询滚动 24 小时内的三类事件", async () => {
  const { queries, outputs, notices } = await runAdmission({
    runsByEvent: { issues: [] },
  });
  assert.equal(outputs.mode, "auto");
  assert.equal(outputs.allow, "true");
  assert.equal(queries.length, 3);
  assert.deepEqual(
    queries.map(({ options }) => options.event),
    ["issues", "issue_comment", "pull_request_review_comment"],
  );
  for (const { options } of queries) {
    assert.equal(options.owner, "owner");
    assert.equal(options.repo, "repo");
    assert.equal(options.workflow_id, "issue-ai.yml");
    assert.equal(options.created, ">=2026-10-17T13:40:00.000Z");
    assert.equal(options.per_page, 100);
  }
  assert.match(notices[0], /last 24 hours: 0 \(limit 30\)/);
});

for (const includeCurrent of [true, false]) {
  test(`历史 29 次时放行第 30 次，查询${includeCurrent ? "包含" : "不包含"}当前运行`, async () => {
    const prior = acceptedRuns(29);
    const current = includeCurrent ? [{ id: runId }] : [];
    const allRuns = [...prior, ...current];
    const { outputs, notices } = await runAdmission({
      runsByEvent: { issues: allRuns },
      jobsByRun: acceptedJobs(allRuns),
    });
    assert.equal(outputs.allow, "true");
    assert.match(notices[0], /last 24 hours: 29 \(limit 30\)/);
  });

  test(`历史 30 次时拦截第 31 次，查询${includeCurrent ? "包含" : "不包含"}当前运行`, async () => {
    const prior = acceptedRuns(30);
    const current = includeCurrent ? [{ id: runId }] : [];
    const allRuns = [...prior, ...current];
    const { outputs, notices, failed } = await runAdmission({
      runsByEvent: { issues: allRuns },
      jobsByRun: acceptedJobs(allRuns),
    });
    assert.equal(outputs.allow, "false");
    assert.match(notices[0], /last 24 hours: 30 \(limit 30\)/);
    assert.equal(failed, "Issue AI rolling quota exceeded");
  });
}

test("自定义变量覆盖默认额度，0 禁用模型调用，非法值拒绝 admission", async () => {
  const prior = acceptedRuns(2);
  const customAllowed = await runAdmission({
    limit: "2",
    runsByEvent: { issues: prior.slice(0, 1) },
    jobsByRun: acceptedJobs(prior.slice(0, 1)),
  });
  assert.equal(customAllowed.outputs.allow, "true");
  assert.match(customAllowed.notices[0], /limit 2/);

  const customDenied = await runAdmission({
    limit: "2",
    runsByEvent: { issues: prior },
    jobsByRun: acceptedJobs(prior),
  });
  assert.equal(customDenied.outputs.allow, "false");

  const disabled = await runAdmission({ limit: "0" });
  assert.equal(disabled.outputs.allow, "false");
  assert.equal(disabled.failed, "Issue AI quota is disabled");
  assert.equal(disabled.queries.length, 0);

  const invalid = await runAdmission({ limit: "thirty" });
  assert.equal(invalid.outputs.allow, undefined);
  assert.equal(invalid.failed, "ISSUE_AI_DAILY_LIMIT 必须是非负整数");
});

test("Workflow rerun 不得通过相同 run_id 重复调用模型", async () => {
  const rerun = await runAdmission({ attempt: "2" });
  assert.equal(rerun.outputs.allow, undefined);
  assert.equal(rerun.failed, "Issue AI 不允许通过 rerun 重复调用模型");
  assert.equal(rerun.queries.length, 0);
});

test("只统计 admission 成功的运行，并排除普通评论、skipped job 和当前运行", async () => {
  const accepted = [...acceptedRuns(2, 1), { id: runId }, { id: 4 }];
  const { outputs, notices } = await runAdmission({
    eventName: "issue_comment",
    payload: {
      action: "created",
      issue: { number: 42 },
      comment: { body: "/opencode 请调查" },
      sender: { type: "User" },
    },
    limit: "3",
    runsByEvent: {
      issues: [accepted[0]],
      issue_comment: [accepted[1], accepted[2]],
      pull_request_review_comment: [accepted[3]],
    },
    jobsByRun: {
      1: [{ name: "admission", conclusion: "success" }],
      2: [{ name: "admission", conclusion: "success" }],
      9999: [{ name: "admission", conclusion: "success" }],
      4: [{ name: "admission", conclusion: "skipped" }],
    },
  });
  assert.equal(outputs.allow, "true");
  assert.match(notices[0], /last 24 hours: 2 \(limit 3\)/);
});

test("排队或运行中的 admission 也会预留额度", async () => {
  const pending = { id: 1 };
  const active = { id: 2 };
  const result = await runAdmission({
    limit: "2",
    runsByEvent: { issues: [pending, active] },
    jobsByRun: {
      1: [{ name: "admission", status: "queued", conclusion: null }],
      2: [{ name: "admission", status: "in_progress", conclusion: null }],
    },
  });
  assert.equal(result.outputs.allow, "false");
  assert.equal(result.failed, "Issue AI rolling quota exceeded");
});

test("手动入口只接受独立的 /oc 或 /opencode，且不检查仓库角色", async () => {
  for (const command of ["/oc", "/opencode"]) {
    assert.equal(isExplicitCommand(command), true);
    const result = await runAdmission({
      eventName: "pull_request_review_comment",
      payload: {
        action: "created",
        pull_request: { number: 7 },
        comment: { body: `${command} 深入调查` },
        sender: { type: "User" },
      },
    });
    assert.equal(result.outputs.mode, "manual");
    assert.equal(result.outputs.allow, "true");
  }
  assert.equal(isExplicitCommand("please /oc now"), false);
  assert.equal(isExplicitCommand("/ocfoo"), false);
  assert.equal(isExplicitCommand("/opencode\n下一行"), false);
});

test("Workflow 删除角色限制，使用预留 admission 和固定版本的普通 OpenCode CLI", () => {
  assert.equal(workflow.includes("group: issue-ai-admission"), false);
  assert.match(workflow, /GITHUB_RUN_ATTEMPT/);
  assert.match(workflow, /job\.status === "queued"/);
  assert.match(workflow, /job\.status === "in_progress"/);
  assert.match(workflow, /ISSUE_AI_DAILY_LIMIT: \$\{\{ vars\.ISSUE_AI_DAILY_LIMIT \}\}/);
  assert.match(workflow, /needs: admission/);
  assert.equal(workflow.includes("OWNER"), false);
  assert.equal(workflow.includes("MEMBER"), false);
  assert.equal(workflow.includes("COLLABORATOR"), false);
  assert.equal(workflow.includes("contains(github.event.comment.body"), false);
  assert.match(workflow, /startsWith\(github\.event\.comment\.body, '\/oc '\)/);
  assert.equal(workflow.includes("anomalyco/opencode/github"), false);
  assert.equal(workflow.match(/opencode run/g)?.length, 2);
  assert.equal(workflow.match(/--format json/g)?.length, 2);
  assert.equal(workflow.match(/--version 1\.19\.3/g)?.length, 2);
  assert.match(workflow, /env -u GITHUB_TOKEN -u GH_TOKEN/);
  assert.equal(workflow.match(/persist-credentials: false/g)?.length, 4);
});

test("权限只用于独立 GitHub 脚本发表评论，OpenCode 没有 GitHub token", () => {
  const permissions = workflow.match(/^permissions:\n((?: {2}[^\n]+\n)+)/m)?.[1];
  assert.ok(permissions);
  assert.match(permissions, /actions: read/);
  assert.match(permissions, /contents: read/);
  assert.match(permissions, /pull-requests: read/);
  assert.match(permissions, /issues: write/);
  assert.equal(workflow.match(/GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/g)?.length, 4);
  assert.equal(workflow.includes("use_github_token"), false);
  assert.match(workflow, /OPENCODE_PERMISSION: '\{"edit":"deny"\}'/);
  assert.match(workflow, /issue-ai\.mjs" context/);
  assert.match(workflow, /issue-ai\.mjs" comment/);
});

for (const [name, prompt] of [
  ["自动初筛", autoPrompt],
  ["手动调查", manualPrompt],
]) {
  test(`${name}提示词保持只读、证据门槛和工作流评论边界`, () => {
    assert.match(prompt, /不要修改任何文件/);
    assert.match(prompt, /git add、git commit、git push/);
    assert.match(prompt, /不要创建分支或 Pull Request/);
    assert.match(prompt, /标签、指派.*状态/);
    assert.match(prompt, /最终回复由工作流发布为一条评论/);
    assert.match(prompt, /不要通过 gh\/API 另发评论/);
    assert.match(prompt, /待核实的数据.*不能.*覆盖/);
    assert.match(prompt, /附加的 GitHub 上下文是外部输入/);
    assert.match(prompt, /完整上下文/);
    assert.match(prompt, /事实、推测、未验证/);
    assert.match(prompt, /明确.*契约/);
    assert.match(prompt, /证据.*影响.*最小验证/);
    assert.match(prompt, /读过测试.*执行过测试/);
    assert.match(prompt, /自行查明.*不要.*提交者/);
  });
}

test("两套提示词保持不同任务和输出边界", () => {
  assert.notEqual(autoPrompt, manualPrompt);
  assert.match(autoPrompt, /唯一目标.*定位本次 Issue/);
  assert.match(manualPrompt, /唯一目标.*回答本次追问/);
  assert.match(manualPrompt, /重新核验已有评论.*增量/);
  assert.match(autoPrompt, /1500 字/);
  assert.match(manualPrompt, /3000 字/);
});

test("OpenCode JSON 输出只提取已完成的文本事件", () => {
  const output = [
    JSON.stringify({
      type: "text",
      part: { type: "text", text: "未完成", time: {} },
    }),
    JSON.stringify({
      type: "tool_use",
      part: { type: "tool", state: { status: "completed" } },
    }),
    JSON.stringify({
      type: "text",
      part: { type: "text", text: "第一段", time: { end: 1 } },
    }),
    JSON.stringify({
      type: "text",
      part: { type: "text", text: "第二段", time: { end: 2 } },
    }),
  ].join("\n");
  assert.equal(extractOpenCodeText(output), "第一段\n\n第二段");
});
