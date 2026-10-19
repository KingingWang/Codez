import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorktreeCreationGate } from "./worktreeCreationModel.js";
import type { IGitService } from "@codez/services";
import type { GitLocalBranch, GitRepositorySummary, GitWorktreeCreatePreview } from "@codez/shared";
import {
  createWorktreeCreationSession,
  applyWorktreeCreateResult,
  buildWorktreePreviewRequest,
  canSubmitWorktreeCreation,
  createWorktreeDialogSessionStore,
  createInitialWorktreeCreationFormState,
  createWorktreeRequestFingerprint,
  isWorktreeCreationInputMutable,
  reduceWorktreePreview,
  resolveWorktreeCreationAvailability,
  runWorktreeCreation,
  shouldCloseAfterWorktreeCreation,
} from "./useWorktreeCreation.js";

function fakeSummary(overrides: Partial<GitRepositorySummary> = {}): GitRepositorySummary {
  return {
    workspacePath: "/repo/subdir",
    repoRoot: "/repo",
    workspaceInRepoPath: "subdir",
    autoRefreshWatchPaths: [],
    gitCommonDir: "/repo/.git",
    branchName: "main",
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: true,
    isGitAvailable: true,
    isRepository: true,
    ...overrides,
  };
}

function fakeBranch(name: string, worktreePath?: string): GitLocalBranch {
  return {
    name,
    isCurrent: name === "main",
    upstreamName: null,
    commitHash: "0123456789abcdef0123456789abcdef01234567",
    commitTimestampMs: 1,
    worktreePath: worktreePath ?? null,
  };
}

function previewResult(
  overrides: Partial<GitWorktreeCreatePreview> = {},
): GitWorktreeCreatePreview {
  return {
    workspacePath: "/repo/subdir",
    repoRoot: "/repo",
    gitCommonDir: "/repo/.git",
    mode: "new-branch",
    branchName: "feature/new",
    startPoint: "HEAD",
    baselineCommit: "0123456789abcdef0123456789abcdef01234567",
    targetPath: "/repo-worktrees/feature-new",
    sourceBranchName: null,
    occupiedPath: null,
    ...overrides,
  };
}

function fakeService(
  impl: {
    summary?: GitRepositorySummary;
    summaryError?: Error;
    previewError?: Error & { code?: number };
    previewRequests?: Record<string, unknown>[];
    createError?: Error;
  } = {},
): IGitService & { calls: string[] } {
  const calls: string[] = [];
  const service = {
    calls,
    async getRepositorySummary() {
      calls.push("summary");
      if (impl.summaryError) throw impl.summaryError;
      return impl.summary ?? fakeSummary();
    },
    async getLocalBranches() {
      calls.push("branches");
      return {
        headRefType: "branch" as const,
        currentBranchName: "main",
        branches: [fakeBranch("main"), fakeBranch("feature"), fakeBranch("occupied", "/other")],
      };
    },
    async previewWorktreeCreation(request: Record<string, unknown>) {
      calls.push(`preview:${JSON.stringify(request)}`);
      impl.previewRequests?.push(request);
      if (impl.previewError) throw impl.previewError;
      return previewResult(request as Partial<GitWorktreeCreatePreview>);
    },
    async createWorktree(request: Record<string, unknown>) {
      calls.push(`create:${JSON.stringify(request)}`);
      if (impl.createError) throw impl.createError;
      return {
        workspacePath: request.targetPath,
        branchName: request.branchName,
        baselineCommit: request.baselineCommit,
        created: true,
      };
    },
  };
  return service as unknown as IGitService & { calls: string[] };
}

test("platform open restrictions and disconnect override a previously ready Git capability", () => {
  assert.equal(
    resolveWorktreeCreationGate({
      allowOpenWorkspace: false,
      rpcReady: true,
      availability: "ready",
    }),
    "unsupported",
  );
  assert.equal(
    resolveWorktreeCreationGate({
      allowOpenWorkspace: true,
      rpcReady: false,
      availability: "ready",
    }),
    "disconnected",
  );
  assert.equal(
    resolveWorktreeCreationGate({
      allowOpenWorkspace: true,
      rpcReady: true,
      availability: "not-git",
    }),
    "not-git",
  );
});

test("availability distinguishes non-Git, disconnected, and legacy method states", async () => {
  assert.equal(
    await resolveWorktreeCreationAvailability({
      service: fakeService({ summary: fakeSummary({ isRepository: false }) }),
      workspacePath: "/plain",
    }),
    "not-git",
  );
  assert.equal(
    await resolveWorktreeCreationAvailability({
      service: fakeService({
        summary: fakeSummary({ isGitAvailable: false, isRepository: false }),
      }),
      workspacePath: "/no-git",
    }),
    "git-unavailable",
  );

  const disconnected = new Error("CODEZ_REMOTE_WORKSPACE_DISCONNECTED") as Error & {
    code: string;
  };
  disconnected.code = "CODEZ_REMOTE_WORKSPACE_DISCONNECTED";
  assert.equal(
    await resolveWorktreeCreationAvailability({
      service: fakeService({ summaryError: disconnected }),
      workspacePath: "/remote/repo",
    }),
    "disconnected",
  );

  const legacyError = new Error("method not found") as Error & { code: number };
  legacyError.code = -32601;
  assert.equal(
    await resolveWorktreeCreationAvailability({
      service: fakeService({ previewError: legacyError }),
      workspacePath: "/repo",
    }),
    "unsupported",
  );
});

test("detached HEAD capability probe uses a unique new branch from HEAD", async () => {
  const previewRequests: Record<string, unknown>[] = [];
  const service = fakeService({
    summary: fakeSummary({ branchName: null, headRefType: "detached" }),
    previewRequests,
  });
  assert.equal(
    await resolveWorktreeCreationAvailability({ service, workspacePath: "/repo" }),
    "ready",
  );
  assert.equal(previewRequests.length, 1);
  const request = previewRequests[0]!;
  assert.equal(request.mode, "new-branch");
  assert.match(request.branchName as string, /^codez-preview-[0-9a-f-]{36}$/u);
  assert.equal(request.startPoint, "HEAD");
});

test("preview confirmation is bound to the exact request fingerprint and source identity", () => {
  const request = buildWorktreePreviewRequest({
    workspacePath: "/repo/subdir",
    sourceWorkspaceKey: "/repo/subdir",
    operationId: "019778d0-7c68-7ac0-91aa-38d945cd1111",
    form: {
      ...createInitialWorktreeCreationFormState(),
      mode: "new-branch",
      branchName: "feature/new",
      startPoint: "main",
      targetPath: "/custom/tree",
      targetPathTouched: true,
    },
  });
  assert.deepEqual(request, {
    workspacePath: "/repo/subdir",
    operationId: "019778d0-7c68-7ac0-91aa-38d945cd1111",
    mode: "new-branch",
    branchName: "feature/new",
    startPoint: "main",
    targetPath: "/custom/tree",
  });

  const fingerprint = createWorktreeRequestFingerprint(request, "/repo/subdir");
  const state = reduceWorktreePreview(
    { ...createInitialWorktreeCreationFormState(), previewSequence: 3 },
    {
      preview: previewResult({
        mode: "new-branch",
        branchName: "feature/new",
        startPoint: "main",
        targetPath: "/custom/tree",
      }),
      fingerprint,
    },
  );
  assert.equal(
    canSubmitWorktreeCreation({ state, request, sourceWorkspaceKey: "/repo/subdir" }),
    true,
  );
  assert.equal(
    canSubmitWorktreeCreation({
      state,
      request: { ...request, branchName: "feature/changed" },
      sourceWorkspaceKey: "/repo/subdir",
    }),
    false,
  );
  assert.equal(
    canSubmitWorktreeCreation({ state, request, sourceWorkspaceKey: "/other/source" }),
    false,
  );
});

test("occupied branch cannot submit and carries its host path", () => {
  const state = reduceWorktreePreview(createInitialWorktreeCreationFormState(), {
    preview: previewResult({
      mode: "existing-branch",
      branchName: "occupied",
      startPoint: "occupied",
      targetPath: "/repo-worktrees/occupied",
      occupiedPath: "/other/worktree",
    }),
    fingerprint: "fingerprint",
  });
  assert.equal(state.occupiedPath, "/other/worktree");
  assert.equal(
    canSubmitWorktreeCreation({ state, request: null, sourceWorkspaceKey: "/repo" }),
    false,
  );
});

test("unknown create failure keeps operationId and immutable request inputs", async () => {
  const service = fakeService({ createError: new Error("timeout") });
  const operationId = "019778d0-7c68-7ac0-91aa-38d945cd2222";
  const request = buildWorktreePreviewRequest({
    workspacePath: "/repo/subdir",
    sourceWorkspaceKey: "/repo/subdir",
    operationId,
    form: {
      ...createInitialWorktreeCreationFormState(),
      mode: "new-branch",
      branchName: "feature/new",
    },
  });
  const state = reduceWorktreePreview(createInitialWorktreeCreationFormState(), {
    preview: previewResult(),
    fingerprint: createWorktreeRequestFingerprint(request, "/repo/subdir"),
  });

  const failed = await runWorktreeCreation({
    service,
    state,
    request,
    operationId,
    onCreated: async () => {},
  });
  assert.equal(failed.phase, "create-unknown");
  assert.equal(failed.pending, false);
  assert.equal(isWorktreeCreationInputMutable(failed), false);
  assert.equal(failed.preview, state.preview);
  assert.equal(failed.operationId, operationId);
  assert.equal(
    canSubmitWorktreeCreation({ state: failed, request, sourceWorkspaceKey: "/repo/subdir" }),
    true,
  );
  assert.equal(service.calls.filter((call) => call.startsWith("create:")).length, 1);

  const retriedUnknown = await runWorktreeCreation({
    service,
    state: failed,
    request,
    operationId,
    onCreated: async () => {},
  });
  assert.equal(retriedUnknown.phase, "create-unknown");
  assert.equal(service.calls.filter((call) => call.startsWith("create:")).length, 2);
  const retryPayload = JSON.parse(service.calls.at(-1)!.replace(/^create:/, "")) as Record<
    string,
    unknown
  >;
  assert.equal(retryPayload.operationId, operationId);
  assert.equal(retryPayload.branchName, state.preview!.branchName);
  assert.equal(retryPayload.targetPath, state.preview!.targetPath);
});

test("creation success is followed by frozen open callback; open retry never creates again", async () => {
  const service = fakeService();
  const operationId = "019778d0-7c68-7ac0-91aa-38d945cd3333";
  let openCalls = 0;
  let openResult: "fail" | "succeed" = "fail";
  const request = buildWorktreePreviewRequest({
    workspacePath: "/repo/subdir",
    sourceWorkspaceKey: "/repo/subdir",
    operationId,
    form: {
      ...createInitialWorktreeCreationFormState(),
      mode: "existing-branch",
      branchName: "feature",
    },
  });
  const state = reduceWorktreePreview(createInitialWorktreeCreationFormState(), {
    preview: previewResult({
      mode: "existing-branch",
      branchName: "feature",
      startPoint: "feature",
      targetPath: "/repo-worktrees/feature",
    }),
    fingerprint: createWorktreeRequestFingerprint(request, "/repo/subdir"),
  });

  const first = await runWorktreeCreation({
    service,
    state,
    request,
    operationId,
    onCreated: async () => {
      openCalls += 1;
      if (openResult === "fail") throw new Error("open failed");
    },
  });
  assert.equal(openCalls, 1);
  assert.equal(first.phase, "created");
  assert.equal(first.openError, "open failed");
  assert.equal(service.calls.filter((call) => call.startsWith("create:")).length, 1);

  openResult = "succeed";
  const retried = await runWorktreeCreation({
    service,
    state: applyWorktreeCreateResult(state, {
      workspacePath: "/repo-worktrees/feature",
      branchName: "feature",
      baselineCommit: "0123456789abcdef0123456789abcdef01234567",
      created: true,
    }),
    request,
    operationId,
    onCreated: async () => {
      openCalls += 1;
    },
  });
  assert.equal(openCalls, 2);
  assert.equal(retried.phase, "opened");
  assert.equal(service.calls.filter((call) => call.startsWith("create:")).length, 1);
});

test("one dialog lifecycle freezes source identity, service, operation, and callbacks", () => {
  const service = fakeService();
  const firstOnCreated = async () => {};
  const firstOnOpenOccupied = () => {};
  const session = createWorktreeCreationSession({
    workspacePath: "/remote/repo",
    workspaceIdentity: "remote-identity:/remote/repo",
    remoteSessionId: "session-a",
    service,
    allowOpenWorkspace: true,
    onCreated: firstOnCreated,
    onOpenOccupied: firstOnOpenOccupied,
    nextOperationId: () => "019778d0-7c68-7ac0-91aa-38d945cd4444",
  });

  assert.equal(session.sourceWorkspaceKey, "remote-identity:/remote/repo");
  assert.equal(session.workspacePath, "/remote/repo");
  assert.equal(session.remoteSessionId, "session-a");
  assert.equal(session.service, service);
  assert.equal(session.operationId, "019778d0-7c68-7ac0-91aa-38d945cd4444");
  assert.equal(session.onCreated, firstOnCreated);
  assert.equal(session.onOpenOccupied, firstOnOpenOccupied);
  assert.equal(session.allowOpenWorkspace, true);
});

test("hidden unknown/created sessions restore only for the same source", () => {
  const store = createWorktreeDialogSessionStore();
  const sourceSession = createWorktreeCreationSession({
    workspacePath: "/remote/repo",
    workspaceIdentity: "remote:/repo",
    service: fakeService(),
    allowOpenWorkspace: true,
    onCreated: async () => {},
  });
  const form: ReturnType<typeof createInitialWorktreeCreationFormState> = {
    ...createInitialWorktreeCreationFormState(),
    phase: "create-unknown",
    operationId: sourceSession.operationId,
    error: "timeout",
  };
  store.retain(sourceSession, form);

  const restored = store.restore("remote:/repo");
  assert.equal(restored?.session.operationId, sourceSession.operationId);
  assert.equal(restored?.form.phase, "create-unknown");
  assert.equal(restored?.form.error, "timeout");
  assert.equal(store.restore("remote:/other"), null);

  const otherSession = createWorktreeCreationSession({
    workspacePath: "/remote/other",
    workspaceIdentity: "remote:/other",
    service: fakeService(),
    allowOpenWorkspace: true,
    onCreated: async () => {},
  });
  store.retain(otherSession, createInitialWorktreeCreationFormState());
  assert.notEqual(
    store.restore("remote:/other")?.session.operationId,
    store.restore("remote:/repo")?.session.operationId,
  );
});

test("successful open is a terminal state and must close the creation dialog", () => {
  assert.equal(shouldCloseAfterWorktreeCreation("opened"), true);
  assert.equal(shouldCloseAfterWorktreeCreation("created"), false);
  assert.equal(shouldCloseAfterWorktreeCreation("create-unknown"), false);
});

test("unknown RPC restore rebinds transport only for the same ready source", () => {
  const store = createWorktreeDialogSessionStore();
  const originalService = fakeService();
  const session = createWorktreeCreationSession({
    workspacePath: "/remote/repo",
    workspaceIdentity: "remote:/repo",
    service: originalService,
    allowOpenWorkspace: true,
    onCreated: async () => {},
    nextOperationId: () => "019778d0-7c68-7ac0-91aa-38d945cd6666",
  });
  const unknownForm = {
    ...createInitialWorktreeCreationFormState(),
    mode: "new-branch" as const,
    branchName: "feature/retry",
    startPoint: "main",
    targetPath: "/remote/repo-worktrees/feature-retry",
    phase: "create-unknown" as const,
    operationId: session.operationId,
    error: "connection lost",
  };
  store.retain(session, unknownForm);

  const nextService = fakeService();
  const rebound = store.restore("remote:/repo", nextService, true);
  assert.equal(rebound?.session.service, nextService);
  assert.equal(rebound?.session.operationId, session.operationId);
  assert.equal(rebound?.session.onCreated, session.onCreated);
  assert.equal(rebound?.form, unknownForm);

  const waitingService = fakeService();
  store.retain(session, unknownForm);
  const waiting = store.restore("remote:/repo", waitingService, false);
  assert.equal(waiting?.session.service, originalService);

  const createdForm = { ...unknownForm, phase: "created" as const, result: null };
  store.retain(session, createdForm);
  const created = store.restore("remote:/repo", waitingService, true);
  assert.equal(created?.session.service, originalService);

  store.retain(session, unknownForm);
  assert.equal(store.restore("remote:/other", waitingService, true), null);
});
