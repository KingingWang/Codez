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
