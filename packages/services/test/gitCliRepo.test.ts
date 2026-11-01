import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GIT_PUSH_OUTPUT_BYTES, DEFAULT_GIT_PUSH_TIMEOUT_MS } from "../src/git/config.js";
import type {
  GitCommandExecutionOptions,
  GitCommandExecutionResult,
  GitCommandProvider,
} from "../src/git/providers/gitCommandProvider.js";
import { createGitService } from "../src/git/gitService.js";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";

const tempDirs: string[] = [];

function createCommandResult(
  options: GitCommandExecutionOptions,
  overrides?: Partial<GitCommandExecutionResult>,
): GitCommandExecutionResult {
  return {
    binaryPath: "git",
    cwd: options.cwd,
    args: options.args,
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  };
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createMockCommandProvider(): {
  commandProvider: GitCommandProvider;
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(
    async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
      const command = options.args.join(" ");
      switch (command) {
        case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
          return createCommandResult(options, {
            stdout: "/repo\npackages/app/\n/repo/.git\n.git\n",
          });
        case "status --porcelain=v2 --branch --untracked-files=all -z":
          return createCommandResult(options, {
            stdout: "# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0",
          });
        case "diff --cached --numstat -z --find-renames --":
        case "diff --numstat -z --find-renames --":
          return createCommandResult(options);
        case "config --show-scope --show-origin --get user.name":
          return createCommandResult(options, {
            stdout: "local\tfile:.git/config\tCodez Tester\n",
          });
        case "config --show-scope --show-origin --get user.email":
          return createCommandResult(options, {
            stdout: "local\tfile:.git/config\ttester@example.com\n",
          });
        case "push":
          return createCommandResult(options);
        default:
          throw new Error(`Unexpected git command in test: ${command}`);
      }
    },
  );

  return {
    commandProvider: {
      resolveGitBinary: vi.fn().mockResolvedValue("git"),
      run,
    },
    run,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("gitCliRepo", () => {
  it("reuses the in-flight status snapshot for concurrent readers", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    const repo = createGitCliRepo({ commandProvider });
    const workspacePath = "/repo/packages/app";

    const [left, right] = await Promise.all([
      repo.getStatus(workspacePath),
      repo.getStatus(workspacePath),
    ]);

    expect(left.summary.repoRoot).toBe("/repo");
    expect(right.summary.workspaceInRepoPath).toBe("packages/app");
    expect(run.mock.calls.map(([options]) => options.args.join(" "))).toEqual([
      "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir",
      "status --porcelain=v2 --branch --untracked-files=all -z",
      "diff --cached --numstat -z --find-renames --",
      "diff --numstat -z --find-renames --",
    ]);
  });

  it("详细状态超限后应按 repoRoot 复用未跟踪目录折叠模式", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    run.mockImplementation(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        switch (command) {
          case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
            return createCommandResult(options, {
              stdout: "/repo\npackages/app/\n/repo/.git\n.git\n",
            });
          case "status --porcelain=v2 --branch --untracked-files=all -z":
            return createCommandResult(options, {
              stdout: "# branch.head main\0? packages/app/.npm/cache/partial-entry\0",
              outputTruncated: true,
            });
          case "status --porcelain=v2 --branch --untracked-files=normal -z":
            return createCommandResult(options, {
              stdout: "# branch.head main\0? packages/app/.npm/\0",
            });
          case "diff --cached --numstat -z --find-renames --":
          case "diff --numstat -z --find-renames --":
            return createCommandResult(options);
          default:
            throw new Error(`Unexpected git command in test: ${command}`);
        }
      },
    );
    const repo = createGitCliRepo({ commandProvider });
    const service = createGitService({ repo });
    const workspacePath = "/repo/packages/app";

    const first = await repo.getStatus(workspacePath);
    const second = await repo.getStatus(workspacePath);
    const changes = await service.getChanges({ workspacePath, sourceId: "unstaged" });

    expect(first.summary).toMatchObject({ branchName: "main", isDirty: true });
    expect(first.entries.map((entry) => entry.path)).toEqual(["packages/app/.npm/"]);
    expect(second.entries.map((entry) => entry.path)).toEqual(["packages/app/.npm/"]);
    expect(changes).toEqual([
      expect.objectContaining({
        workspaceRelativePath: ".npm/",
        section: "untracked",
        added: 0,
        removed: 0,
      }),
    ]);
    expect(
      run.mock.calls.filter(
        ([options]) =>
          options.args.join(" ") === "status --porcelain=v2 --branch --untracked-files=all -z",
      ),
    ).toHaveLength(1);
    expect(
      run.mock.calls.filter(
        ([options]) =>
          options.args.join(" ") === "status --porcelain=v2 --branch --untracked-files=normal -z",
      ),
    ).toHaveLength(3);
  });

  it("reuses the in-flight repository resolution across status and identity reads", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    const repo = createGitCliRepo({ commandProvider });
    const workspacePath = "/repo/packages/app";

    const [status, identity] = await Promise.all([
      repo.getStatus(workspacePath),
      repo.getIdentity(workspacePath),
    ]);

    expect(status.summary.repoRoot).toBe("/repo");
    expect(identity.userName).toBe("Codez Tester");
    expect(
      run.mock.calls.filter(
        ([options]) =>
          options.args.join(" ") ===
          "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir",
      ),
    ).toHaveLength(1);
  });

  it("identifies main-tree workspaces via repoRoot/.git directory", async () => {
    const repoRoot = makeTempDir("codez-git-main-tree-");
    mkdirSync(join(repoRoot, ".git"));
    const workspacePath = join(repoRoot, "packages", "app");
    mkdirSync(workspacePath, { recursive: true });
    const { commandProvider } = createMockCommandProvider();
    commandProvider.run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        if (
          command === "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir"
        ) {
          return createCommandResult(options, {
            stdout: `${repoRoot}\npackages/app/\n${join(repoRoot, ".git")}\n.git\n`,
          });
        }
        throw new Error(`Unexpected git command in test: ${command}`);
      },
    );
    const repo = createGitCliRepo({ commandProvider });

    await expect(repo.getWorkspaceRepositoryInfo(workspacePath)).resolves.toEqual({
      workspacePath,
      kind: "main-tree",
      gitCommonDir: resolve(workspacePath, ".git"),
      isGitAvailable: true,
    });
  });

  it("identifies linked worktree workspaces via repoRoot/.git file", async () => {
    const mainTreeRoot = makeTempDir("codez-git-worktree-main-");
    mkdirSync(join(mainTreeRoot, ".git", "worktrees", "feature"), { recursive: true });
    const worktreeRoot = makeTempDir("codez-git-worktree-linked-");
    writeFileSync(
      join(worktreeRoot, ".git"),
      `gitdir: ${join(mainTreeRoot, ".git", "worktrees", "feature")}\n`,
      "utf-8",
    );
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        switch (command) {
          case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
            return createCommandResult(options, {
              stdout: `${worktreeRoot}\n\n${join(mainTreeRoot, ".git", "worktrees", "feature")}\n${join(mainTreeRoot, ".git")}\n`,
            });
          default:
            throw new Error(`Unexpected git command in test: ${command}`);
        }
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    await expect(repo.getWorkspaceRepositoryInfo(worktreeRoot)).resolves.toEqual({
      workspacePath: worktreeRoot,
      kind: "linked-worktree",
      gitCommonDir: realpathSync(resolve(mainTreeRoot, ".git")),
      isGitAvailable: true,
    });
  });

  it("includes worktree gitdir and common gitdir in status auto-refresh watch paths", async () => {
    const worktreeRoot = "/repo-linked";
    const worktreeGitDir = "/repo-main/.git/worktrees/repo-linked";
    const commonGitDir = "/repo-main/.git";
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        switch (command) {
          case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
            return createCommandResult(options, {
              stdout: `${worktreeRoot}\n\n${worktreeGitDir}\n${commonGitDir}\n`,
            });
          case "status --porcelain=v2 --branch --untracked-files=all -z":
            return createCommandResult(options, {
              stdout: "# branch.head feature\0",
            });
          case "diff --cached --numstat -z --find-renames --":
          case "diff --numstat -z --find-renames --":
            return createCommandResult(options);
          default:
            throw new Error(`Unexpected git command in test: ${command}`);
        }
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    const status = await repo.getStatus(worktreeRoot);

    expect(status.summary.autoRefreshWatchPaths).toEqual([
      {
        path: worktreeGitDir,
        recursive: true,
      },
      {
        path: commonGitDir,
        recursive: true,
      },
    ]);
  });

  it("resolves a relative common git dir from the workspace command cwd", async () => {
    // 根因：本用例是唯一走「相对 --git-common-dir + 宿主 resolve()」的分支，其它用例只做字面量
    // 比较。原来用 POSIX 字面量 "/root/.git" 作断言，而 resolve("/root/demo-project","../.git")
    // 在 win32 上得到 "C:\root\.git" —— 两者不相等，去重失败，watch 路径多出一条。
    // 用宿主 path 组装 fixture，让断言在三个平台上表达同一个"仓库根下的 .git"。
    const repoRoot = resolve("/root");
    const workspacePath = join(repoRoot, "demo-project");
    const absoluteGitDir = join(repoRoot, ".git");
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        if (
          command === "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir"
        ) {
          return createCommandResult(options, {
            stdout: `${repoRoot}\ndemo-project/\n${absoluteGitDir}\n../.git\n`,
          });
        }
        throw new Error(`Unexpected git command in test: ${command}`);
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    const resolution = await repo.resolveRepository(workspacePath);

    expect(resolution.autoRefreshWatchPaths).toEqual([
      {
        path: absoluteGitDir,
        recursive: true,
      },
    ]);
  });

  it("treats spawn git ENOENT during repository resolution as not-repository", async () => {
    const workspacePath = "/missing/worktree-path";
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        if (
          command === "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir"
        ) {
          return createCommandResult(options, {
            exitCode: -2,
            stderr: "spawn git ENOENT",
          });
        }
        throw new Error(`Unexpected git command in test: ${command}`);
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    await expect(repo.getWorkspaceRepositoryInfo(workspacePath)).resolves.toEqual({
      workspacePath,
      kind: "not-repository",
      gitCommonDir: null,
      isGitAvailable: true,
    });
  });

  it("uses the dedicated long timeout and larger output budget for push hooks", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    const repo = createGitCliRepo({ commandProvider });
    const workspacePath = "/repo/packages/app";

    await repo.push(workspacePath);

    const pushCall = run.mock.calls.find(([options]) => options.args.join(" ") === "push");
    expect(pushCall?.[0].timeoutMs).toBe(DEFAULT_GIT_PUSH_TIMEOUT_MS);
    expect(pushCall?.[0].maxOutputBytes).toBe(DEFAULT_GIT_PUSH_OUTPUT_BYTES);
  });

  it("checks ignored paths from argv without using incompatible -z output", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    const repo = createGitCliRepo({ commandProvider });
    const workspacePath = "/repo/packages/app";

    run.mockImplementation(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        if (
          command === "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir"
        ) {
          return createCommandResult(options, {
            stdout: "/repo\npackages/app/\n/repo/.git\n.git\n",
          });
        }
        if (command === "check-ignore -- packages/app/.env packages/app/src/index.ts") {
          return createCommandResult(options, {
            stdout: "packages/app/.env\n",
          });
        }
        throw new Error(`Unexpected git command in test: ${command}`);
      },
    );

    await expect(
      repo.getIgnoredPaths(workspacePath, [
        "/repo/packages/app/.env",
        "/repo/packages/app/src/index.ts",
      ]),
    ).resolves.toEqual(["/repo/packages/app/.env"]);
  });

  it("keeps a valid unstaged patch when the working-tree content cannot be read", async () => {
    const workspacePath = "/repo/packages/app";
    const filePath = "/repo/packages/app/index.vue";
    const patch = [
      "diff --git a/packages/app/index.vue b/packages/app/index.vue",
      "index 1111111..2222222 100644",
      "--- a/packages/app/index.vue",
      "+++ b/packages/app/index.vue",
      "@@ -1,2 +1,3 @@",
      " <template>",
      "+  <SearchSelect />",
      " </template>",
      "",
    ].join("\n");
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        switch (command) {
          case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
            return createCommandResult(options, {
              stdout: "/repo\npackages/app/\n/repo/.git\n.git\n",
            });
          case "diff --no-ext-diff --no-color --binary -- packages/app/index.vue":
            return createCommandResult(options, { stdout: patch });
          case "show :packages/app/index.vue":
            return createCommandResult(options, {
              stdout: "<template>\n</template>\n",
            });
          default:
            throw new Error(`Unexpected git command in test: ${command}`);
        }
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    await expect(
      repo.getDiff({
        workspacePath,
        path: filePath,
        sourceId: "unstaged",
      }),
    ).resolves.toEqual({
      path: filePath,
      availability: "patch",
      patch,
      beforeContent: null,
      afterContent: null,
      summary: null,
    });
  });
});

describe("gitCliRepo worktree list -z capability guard", () => {
  // 本机与 CI 的 git 都 >= 2.36，真机复现不了旧版本；这里用 fake provider 精确给出
  // `git worktree list -h` 的选项表（R15a：能力来自显式探测，不来自错误串）。
  const NUL_PORCELAIN_STDOUT =
    "worktree /repo\0HEAD 0000000000000000000000000000000000000000\0branch refs/heads/main\0\0" +
    "worktree /repo/trees/a\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/a\0\0";
  const SUPPORTED_USAGE =
    "usage: git worktree list [-v | --porcelain [-z]]\n\n" +
    "    --[no-]porcelain      machine-readable output\n" +
    "    -z                    terminate records with a NUL character\n";
  const UNSUPPORTED_USAGE =
    "usage: git worktree list [--porcelain]\n\n    --porcelain       machine-readable output\n";

  function createCapabilityCommandProvider(options: {
    usageText?: string;
    usageThrows?: boolean;
    gitVersion?: string;
  }): {
    commandProvider: GitCommandProvider;
    calls: string[];
    countOf: (command: string) => number;
  } {
    const calls: string[] = [];
    const run = vi.fn(
      async (command: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const argv = command.args.join(" ");
        calls.push(argv);
        switch (argv) {
          case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
            return createCommandResult(command, {
              stdout: "/repo\npackages/app/\n/repo/.git\n.git\n",
            });
          case "worktree list -h":
            if (options.usageThrows) {
              throw new Error("capability probe unavailable");
            }
            // 旧 git 的 `-h` 写 stderr 且退出码非 0，新 git 写 stdout 且退出 0；
            // 这里统一按旧形状给出，实现必须同时读两个流才判得对。
            return createCommandResult(command, {
              stderr: options.usageText ?? "",
              exitCode: 129,
            });
          case "--version":
            return createCommandResult(command, {
              stdout: `${options.gitVersion ?? "git version 2.30.0"}\n`,
            });
          case "worktree list --porcelain -z":
            return createCommandResult(command, { stdout: NUL_PORCELAIN_STDOUT });
          case "worktree list --porcelain":
            throw new Error("本轮不做无 -z 降级：不应执行该命令");
          case "status --porcelain=v2 --branch --untracked-files=all -z":
            return createCommandResult(command, { stdout: "# branch.head main\0" });
          case "diff --cached --numstat -z --find-renames --":
          case "diff --numstat -z --find-renames --":
            return createCommandResult(command);
          default:
            throw new Error(`Unexpected git command in test: ${argv}`);
        }
      },
    );

    return {
      commandProvider: { resolveGitBinary: vi.fn().mockResolvedValue("git"), run },
      calls,
      countOf: (command: string) => calls.filter((entry) => entry === command).length,
    };
  }

  it("Git < 2.36：抛稳定错误码与升级建议，不执行必然失败的命令，也不重复探测", async () => {
    const { commandProvider, calls, countOf } = createCapabilityCommandProvider({
      usageText: UNSUPPORTED_USAGE,
      gitVersion: "git version 2.30.0",
    });
    const repo = createGitCliRepo({ commandProvider });

    const error = (await repo
      .listWorktrees("/repo/packages/app")
      .catch((caught: unknown) => caught)) as {
      code?: string;
      message?: string;
      data?: {
        code?: string;
        message?: string;
        minGitVersion?: string;
        detectedGitVersion?: string | null;
      };
    };

    expect(error.code).toBe("git_worktree_list_nul_unsupported");
    expect(error.data?.code).toBe("git_worktree_list_nul_unsupported");
    expect(error.data?.minGitVersion).toBe("2.36.0");
    expect(error.data?.detectedGitVersion).toBe("git version 2.30.0");
    // message 只含版本事实与升级建议，不泄漏仓库路径或 git 原始 stderr。
    expect(error.data?.message).toContain("Git 2.36.0 or newer");
    expect(error.data?.message).toContain("git version 2.30.0");
    expect(error.data?.message).not.toContain("/repo");
    expect(error.data?.message).not.toContain("unknown option");

    // 不执行必然失败的 `-z` 命令，也不做无 `-z` 降级。
    expect(calls).not.toContain("worktree list --porcelain -z");
    expect(calls).not.toContain("worktree list --porcelain");

    // 缓存生效：第二次发现不再探测、不再取版本（无无限重试）。
    await expect(repo.listWorktrees("/repo/packages/app")).rejects.toMatchObject({
      code: "git_worktree_list_nul_unsupported",
    });
    expect(countOf("worktree list -h")).toBe(1);
    expect(countOf("--version")).toBe(1);

    // 旧 Git 上普通功能不受影响：状态读取照常工作（地板仍是 2.23）。
    const status = await repo.getStatus("/repo/packages/app");
    expect(status.summary.branchName).toBe("main");
  });

  it("Git >= 2.36：探测到 -z 后正常列举，探测只做一次", async () => {
    const { commandProvider, countOf } = createCapabilityCommandProvider({
      usageText: SUPPORTED_USAGE,
    });
    const repo = createGitCliRepo({ commandProvider });

    const first = await repo.listWorktrees("/repo/packages/app");
    expect(first.isRepository).toBe(true);
    expect(first.worktrees.length).toBe(2);
    expect(first.worktrees[0]?.isMain).toBe(true);
    expect(first.worktrees[1]?.branchName).toBe("a");

    const second = await repo.listWorktrees("/repo/packages/app");
    expect(second.worktrees.length).toBe(2);

    expect(countOf("worktree list -h")).toBe(1);
    expect(countOf("worktree list --porcelain -z")).toBe(2);
    // 支持时不需要额外取版本号。
    expect(countOf("--version")).toBe(0);
  });

  it("并发发现共享同一次能力探测", async () => {
    const { commandProvider, countOf } = createCapabilityCommandProvider({
      usageText: SUPPORTED_USAGE,
    });
    const repo = createGitCliRepo({ commandProvider });

    const results = await Promise.all([
      repo.listWorktrees("/repo/packages/app"),
      repo.listWorktrees("/repo/packages/app"),
    ]);

    expect(results.every((result) => result.worktrees.length === 2)).toBe(true);
    expect(countOf("worktree list -h")).toBe(1);
  });

  it("探测不可用时 fail-open：保持既有 -z 行为，不误报升级", async () => {
    const { commandProvider, calls, countOf } = createCapabilityCommandProvider({
      usageThrows: true,
    });
    const repo = createGitCliRepo({ commandProvider });

    const result = await repo.listWorktrees("/repo/packages/app");
    expect(result.worktrees.length).toBe(2);
    expect(calls).toContain("worktree list --porcelain -z");
    expect(countOf("--version")).toBe(0);
  });

  it("用法文本为空时 fail-open：不当作能力缺失", async () => {
    const { commandProvider, calls } = createCapabilityCommandProvider({ usageText: "" });
    const repo = createGitCliRepo({ commandProvider });

    const result = await repo.listWorktrees("/repo/packages/app");
    expect(result.worktrees.length).toBe(2);
    expect(calls).toContain("worktree list --porcelain -z");
  });
});
