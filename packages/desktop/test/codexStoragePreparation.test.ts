import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseStartupState } from "@codez/shared";
import { prepareSessionStorage } from "../src/host/storagePreparationProcesses.js";
import { DatabaseStartupCoordinator } from "../src/host/databaseStartupCoordinator.js";

test("Codex storage preflight reports no migration and reaches the startup UI ready state", async () => {
  const previous = process.env.CODEZ_AGENT_SERVER_COMMAND;
  delete process.env.CODEZ_AGENT_SERVER_COMMAND;
  const states: DatabaseStartupState[] = [];
  const preparedPaths = new Set<string>();
  let initialized = false;
  const coordinator = new DatabaseStartupCoordinator({
    publish: (state) => states.push(state),
    async prepare(report) {
      report("preparing_session_storage", "checking");
      await prepareSessionStorage({
        // Runtime availability is checked when starting Codex, not by legacy DB preflight.
        cwd: "/no-legacy-session-database",
        signal: new AbortController().signal,
        preparedPaths,
        observePath: async () => {
          assert.fail("Codex must not open a legacy database");
        },
        report: (phase, details) =>
          report("preparing_session_storage", phase, {
            databaseId: details?.databaseId ?? "session",
            migration: details?.migration,
            finalDatabase: true,
          }),
      });
      report("starting_services");
      initialized = true;
    },
  });
  try {
    await coordinator.start();
    assert.equal(initialized, true);
    assert.equal(coordinator.snapshot.phase, "ready");
    assert.equal(preparedPaths.size, 0);
    assert.ok(
      states.some(
        (state) => state.phase === "preparing_session_storage" && state.databasePhase === "ready",
      ),
    );
    assert.deepEqual(coordinator.snapshot.migration, {
      kind: "none",
      executedCount: 0,
      committedCount: 0,
    });
    assert.equal(
      states.some((state) => state.phase === "failed"),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.CODEZ_AGENT_SERVER_COMMAND;
    else process.env.CODEZ_AGENT_SERVER_COMMAND = previous;
  }
});

test("an aborted preflight never acknowledges ready", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    prepareSessionStorage({
      cwd: "/not-used",
      signal: abort.signal,
      report() {
        assert.fail("aborted startup cannot report ready");
      },
      observePath: async () => {
        assert.fail("aborted startup cannot touch storage");
      },
    }),
    { kind: "transport_closed" },
  );
});

test("explicit legacy commands retain the unsupported storage capability failure", async () => {
  const previous = process.env.CODEZ_AGENT_SERVER_COMMAND;
  process.env.CODEZ_AGENT_SERVER_COMMAND = "/explicit/legacy-command";
  try {
    await assert.rejects(
      prepareSessionStorage({
        cwd: "/not-used",
        signal: new AbortController().signal,
        report() {
          assert.fail("legacy override must not receive a Codex ready acknowledgement");
        },
        observePath: async () => {
          assert.fail("unsupported commands cannot touch storage");
        },
      }),
      { kind: "unsupported_runtime" },
    );
  } finally {
    if (previous === undefined) delete process.env.CODEZ_AGENT_SERVER_COMMAND;
    else process.env.CODEZ_AGENT_SERVER_COMMAND = previous;
  }
});
