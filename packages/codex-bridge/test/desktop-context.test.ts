import assert from "node:assert/strict";
import test from "node:test";
import type { CodexRpcPort } from "../src/contract.js";
import {
  CODEZ_DESKTOP_CONTEXT_PROMPT,
  prepareCodexDesktopContext,
} from "../src/desktop-context.js";

function fixture(developerInstructions: unknown = "Synthetic user instructions.") {
  const calls: { method: string; params: unknown }[] = [];
  const request: CodexRpcPort["request"] = async <T>(method: string, params?: unknown) => {
    calls.push({ method, params });
    assert.equal(method, "config/read");
    return { config: { developer_instructions: developerInstructions } } as T;
  };
  return {
    calls,
    request,
    options: { cwd: "/synthetic/workspace", desktopContextPromptEnabled: true },
  };
}

for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
  test(`${method} preserves effective user instructions and all native parameters`, async () => {
    const f = fixture();
    const params = {
      threadId: "thread-1",
      model: "fixture-model",
      baseInstructions: "Synthetic model override.",
      cwd: f.options.cwd,
    };
    const prepared = await prepareCodexDesktopContext(method, params, f.options, f.request);
    assert.deepEqual(prepared, {
      ...params,
      developerInstructions: `Synthetic user instructions.\n\n${CODEZ_DESKTOP_CONTEXT_PROMPT}`,
    });
    assert.equal("developerInstructions" in params, false, "caller input is not mutated");
    assert.deepEqual(f.calls, [
      { method: "config/read", params: { cwd: f.options.cwd, includeLayers: false } },
    ]);
  });
}

test("disabled, ordinary requests and ephemeral/system threads are untouched", async () => {
  const f = fixture();
  for (const [method, params, enabled] of [
    ["thread/start", { cwd: f.options.cwd }, false],
    ["thread/resume", { threadId: "thread-1" }, false],
    ["turn/start", { threadId: "thread-1", input: [] }, true],
    ["thread/queue/add", { threadId: "thread-1" }, true],
    ["thread/read", { threadId: "thread-1" }, true],
    ["thread/start", { ephemeral: true }, true],
    ["thread/start", { threadSource: "system" }, true],
  ] as const) {
    assert.equal(
      await prepareCodexDesktopContext(
        method,
        params,
        { ...f.options, desktopContextPromptEnabled: enabled },
        f.request,
      ),
      params,
    );
  }
  assert.deepEqual(f.calls, []);
});

test("explicit and request-config developer overrides preserve native precedence", async () => {
  const f = fixture();
  for (const explicit of ["Explicit synthetic instructions.", ""]) {
    const params = { developerInstructions: explicit, config: { developer_instructions: "lower" } };
    assert.deepEqual(
      await prepareCodexDesktopContext("thread/start", params, f.options, f.request),
      {
        ...params,
        developerInstructions: explicit
          ? `${explicit}\n\n${CODEZ_DESKTOP_CONTEXT_PROMPT}`
          : CODEZ_DESKTOP_CONTEXT_PROMPT,
      },
    );
  }
  const params = {
    developerInstructions: null,
    config: {
      developer_instructions: "Request config instructions.",
      "tools.update_plan.enabled": false,
    },
  };
  assert.deepEqual(await prepareCodexDesktopContext("thread/fork", params, f.options, f.request), {
    ...params,
    developerInstructions: `Request config instructions.\n\n${CODEZ_DESKTOP_CONTEXT_PROMPT}`,
  });
  assert.deepEqual(f.calls, [], "explicit overrides do not need another config read");
});

test("null overrides inherit configuration and no user instructions is supported", async () => {
  const f = fixture(null);
  assert.deepEqual(
    await prepareCodexDesktopContext(
      "thread/resume",
      {
        threadId: "thread-1",
        developerInstructions: null,
        config: { developer_instructions: null },
      },
      f.options,
      f.request,
    ),
    {
      threadId: "thread-1",
      developerInstructions: CODEZ_DESKTOP_CONTEXT_PROMPT,
      config: { developer_instructions: null },
    },
  );
});

test("repeated composition replaces only the reserved desktop section", async () => {
  const f = fixture();
  const params = {
    developerInstructions: `Keep this.\n\n${CODEZ_DESKTOP_CONTEXT_PROMPT}\n\nKeep that.`,
  };
  const once = await prepareCodexDesktopContext("thread/start", params, f.options, f.request);
  const twice = await prepareCodexDesktopContext("thread/resume", once, f.options, f.request);
  assert.deepEqual(twice, once);
  const instructions = (twice as { developerInstructions: string }).developerInstructions;
  assert.equal(instructions.split("<codez-desktop-context>").length - 1, 1);
  assert.ok(instructions.includes("Keep this.") && instructions.includes("Keep that."));
  assert.deepEqual(f.calls, []);
});

test("configuration changes are observed at the next lifecycle admission", async () => {
  const f = fixture();
  await prepareCodexDesktopContext("thread/start", {}, f.options, f.request);
  await prepareCodexDesktopContext("thread/resume", {}, f.options, f.request);
  assert.equal(f.calls.length, 2, "no second configuration cache");
});

test("configuration failure or invalid instructions reject without lifecycle mutation", async () => {
  const f = fixture(42);
  await assert.rejects(prepareCodexDesktopContext("thread/start", {}, f.options, f.request));
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["config/read"],
  );
  const failure = new Error("Synthetic configuration failure");
  await assert.rejects(
    prepareCodexDesktopContext("thread/resume", {}, f.options, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});

test("decorated instructions guide actual supported math and omit legacy tools", async () => {
  const f = fixture("");
  const prepared = await prepareCodexDesktopContext("thread/start", {}, f.options, f.request);
  const instructions = (prepared as { developerInstructions: string }).developerInstructions;
  assert.ok(instructions.includes("$...$") && instructions.includes("$$...$$"));
  assert.ok(
    instructions.includes(String.raw`\(...\)`) && instructions.includes(String.raw`\[...\]`),
  );
  assert.match(instructions, /outside Markdown table cells/);
  assert.doesNotMatch(instructions, /CronCreate|TaskOutput|load_workspace_dependencies|::git-/);
});
