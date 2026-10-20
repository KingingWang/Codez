/* eslint-disable max-lines -- 编辑器打开链路需集中维护本地路径、SSH/WSL 远程 URI 与跨平台 CLI 回退逻辑。 */
import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join, win32, win32 as pathWin32 } from "node:path";
import { shell } from "electron";
import type { OpenInEditorOptions, OpenInEditorRemoteTarget } from "@codez/shared";
import { listSSHConfigAliasesFromLocalConfig } from "@codez/services/node";
import { listWSLDistros } from "@codez/server/remote/wsl-detect.js";
import { getEditorDefsForCurrentPlatform, resolveEditorDefAppPath } from "./editors.js";
import { logger } from "./logger.js";
import {
  getFileApplicationDefs,
  matchesFileApplication,
  resolveFileApplicationPath,
} from "@desktop/main/fileApplications.js";
import { isDelegatedWindowsExplorerExit } from "./windowsExplorerDelegation.js";

type PathKind = "file" | "directory" | "unknown";

interface OpenInEditorResult {
  success: boolean;
  error?: string;
}

const VSCODE_EDITOR_IDS = new Set(["vscode", "vscode-insiders"]);

const stringifyError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const execFileAsync = (file: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, (error) => (error ? reject(error) : resolve()));
  });

const execFileWithEnvAsync = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env }, (error) => (error ? reject(error) : resolve()));
  });

function resolveBundledVSCodeCliPath(appPath: string, command: string | null): string | null {
  if (!command || !appPath) {
    return null;
  }

  if (process.platform === "darwin") {
    // 修复原因：macOS GUI 进程的 PATH 通常不含 /usr/local/bin，且用户未必执行过
    // “Install 'code' command in PATH”；若回退到 `open -a Visual Studio Code.app --args --folder-uri ...`，
    // 当 VS Code 已在运行时 LaunchServices 会忽略 `--args`，表现为只唤起 VS Code 窗口却打不开远程项目。
    // 直接优先定位 .app 包内置的 CLI 脚本即可稳定通过 VS Code IPC 打开远端窗口。
    const candidate = join(appPath, "Contents", "Resources", "app", "bin", command);
    return existsSync(candidate) ? candidate : null;
  }

  if (process.platform === "win32") {
    // 修复原因：Windows 下 `execFile("code", ...)` 无法直接执行 `.cmd` 包装脚本，
    // 优先检查 Code.exe 同级 bin 目录下的可执行入口。
    const appDir = pathWin32.dirname(appPath);
    const candidates = [
      pathWin32.join(appDir, "bin", `${command}.exe`),
      join(appDir, "bin", `${command}.exe`),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolveBundledZedCliPath(appPath: string, command: string | null): string | null {
  if (!command || !appPath) {
    return null;
  }

  if (process.platform === "darwin") {
    // 修复原因：macOS GUI 进程未必继承含 `zed` 的 PATH，且用户可能未执行
    // “Install CLI”；直接优先定位 Zed.app 内置的 `Contents/MacOS/cli` 可稳定打开 `ssh://` 远程路径。
    const candidate = join(appPath, "Contents", "MacOS", "cli");
    return existsSync(candidate) ? candidate : null;
  }

  if (process.platform === "win32") {
    const appDir = pathWin32.dirname(appPath);
    const candidates = [
      pathWin32.join(appDir, "bin", `${command}.exe`),
      join(appDir, "bin", `${command}.exe`),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function resolveWindowsVSCodeCliJsPath(appPath: string): string | null {
  if (process.platform !== "win32" || !appPath) {
    return null;
  }

  // 修复原因：Windows 标准安装包中 `bin\code.cmd` 实际通过
  // `ELECTRON_RUN_AS_NODE=1 Code.exe resources\app\out\cli.js` 把 `--folder-uri` 交给 VS Code CLI；
  // Node `execFile("code", ...)` 无法直接执行 `.cmd` 脚本，而裸调 `Code.exe --folder-uri` 在部分版本下
  // 缺少 CLI 入口对远程 URI 的规范化与 IPC 转发，优先走官方 CLI 脚本入口。
  const appDir = pathWin32.dirname(appPath);
  const candidates = [
    pathWin32.join(appDir, "resources", "app", "out", "cli.js"),
    join(appDir, "resources", "app", "out", "cli.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function openPathViaShell(path: string): Promise<OpenInEditorResult> {
  const error = await shell.openPath(path);
  return error ? { success: false, error } : { success: true };
}

function detectPathKind(path: string): PathKind {
  try {
    const stats = statSync(path);
    if (stats.isFile()) {
      return "file";
    }
    if (stats.isDirectory()) {
      return "directory";
    }
  } catch {
    // 非本地路径或路径不存在时保留 unknown，交给后续 fallback 处理。
  }
  return "unknown";
}

function isVSCodeEditor(editorId: string): boolean {
  return VSCODE_EDITOR_IDS.has(editorId);
}

function normalizeRemotePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function encodeRemotePath(path: string): string {
  return normalizeRemotePath(path)
    .split("/")
    .map((segment, index) => (index === 0 ? "" : encodeURIComponent(segment)))
    .join("/");
}

async function resolveWslDistroName(
  target: Extract<OpenInEditorRemoteTarget, { kind: "wsl" }>,
): Promise<string | null> {
  const explicitDistro = target.distro?.trim();
  if (explicitDistro) {
    return explicitDistro;
  }

  try {
    const distros = await listWSLDistros();
    return distros.find((distro) => distro.isDefault)?.name ?? distros[0]?.name ?? null;
  } catch (error) {
    logger.warn("[editors] 解析默认 WSL distro 失败", {
      error: stringifyError(error),
    });
    return null;
  }
}

function buildWslUncPathCandidates(path: string, distroName: string): string[] {
  const normalizedPath = normalizeRemotePath(path);
  const suffix = normalizedPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("\\");
  const pathSuffix = suffix ? `\\${suffix}` : "";

  return [`\\\\wsl.localhost\\${distroName}${pathSuffix}`, `\\\\wsl$\\${distroName}${pathSuffix}`];
}

async function resolveMatchingSshConfigAlias(
  target: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
): Promise<string | null> {
  const host = target.host.trim().toLowerCase();
  if (!host) {
    return null;
  }
  const targetPort = target.port ?? 22;
  const targetUser = target.username.trim();

  try {
    const aliases = await listSSHConfigAliasesFromLocalConfig();
    const matched = aliases.find((option) => {
      const optionHost = option.host?.trim().toLowerCase();
      if (!optionHost || optionHost !== host) {
        return false;
      }
      const optionPort = option.port ?? 22;
      if (optionPort !== targetPort) {
        return false;
      }
      const optionUser = option.username?.trim() || "";
      return !targetUser || !optionUser || optionUser === targetUser;
    });
    return matched?.alias?.trim() || null;
  } catch (error) {
    logger.warn("[editors] 解析本地 SSH config alias 失败", {
      error: stringifyError(error),
    });
    return null;
  }
}

async function resolveVSCodeSshRemoteAuthority(
  target: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
): Promise<string> {
  const sshConfigAlias = target.sshConfigAlias?.trim();
  if (sshConfigAlias) {
    return sshConfigAlias;
  }

  // 修复原因：用户手填 IP/端口或旧会话未保存 sshConfigAlias 时，若直接拼 user@host:port，
  // VS Code Remote-SSH 一旦在 ~/.ssh/config 命中同名/通配 HostName 会丢弃 URI 中的非默认端口和 IdentityFile。
  // 先反查本机 ~/.ssh/config 中 (host, port, username) 一致的 alias，让 VS Code 复用完整 SSH 配置。
  const matchedAlias = await resolveMatchingSshConfigAlias(target);
  if (matchedAlias) {
    return matchedAlias;
  }

  const username = target.username.trim();
  const host = target.host.trim();
  const userHost = username ? `${username}@${host}` : host;
  return target.port && target.port !== 22 ? `${userHost}:${target.port}` : userHost;
}

async function buildVSCodeSshFolderUri(
  path: string,
  target: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
) {
  // 手填 SSH 目标没有 alias 时，authority 里可能包含 `@` 和 `:`。
  // 直接拼进 URI 会被解析成 userinfo/host/port，必须按 Remote-SSH authority 组件整体编码。
  const encodedAuthority = encodeURIComponent(await resolveVSCodeSshRemoteAuthority(target));
  return `vscode-remote://ssh-remote+${encodedAuthority}${encodeRemotePath(path)}`;
}

async function buildZedSshUri(
  path: string,
  target: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
): Promise<string> {
  const sshConfigAlias = target.sshConfigAlias?.trim();
  if (sshConfigAlias) {
    return `ssh://${encodeURIComponent(sshConfigAlias)}${encodeRemotePath(path)}`;
  }

  const matchedAlias = await resolveMatchingSshConfigAlias(target);
  if (matchedAlias) {
    return `ssh://${encodeURIComponent(matchedAlias)}${encodeRemotePath(path)}`;
  }

  // Zed 直接按标准 URL 解析 `ssh://[user@]host[:port]/path`，
  // 不能像 VS Code Remote-SSH 那样把 `@` 和 `:port` 整体编码，否则会导致主机名与端口解析失败；
  // 但跳板机等包含 `@`/`:` 的特殊 username 仍需单独对 userinfo 组件编码。
  const username = target.username.trim();
  const host = target.host.trim();
  const userHost = username ? `${encodeURIComponent(username)}@${host}` : host;
  const authority = target.port && target.port !== 22 ? `${userHost}:${target.port}` : userHost;
  return `ssh://${authority}${encodeRemotePath(path)}`;
}

async function buildVSCodeWslFolderUri(
  path: string,
  target: Extract<OpenInEditorRemoteTarget, { kind: "wsl" }>,
): Promise<{ uri?: string; error?: string }> {
  const distroName = await resolveWslDistroName(target);
  if (!distroName) {
    return { error: "missing WSL distro for VS Code Remote-WSL" };
  }

  return {
    uri: `vscode-remote://wsl+${encodeURIComponent(distroName)}${encodeRemotePath(path)}`,
  };
}

async function openVSCodeRemoteUri(
  editorId: string,
  appPath: string,
  command: string | null,
  path: string,
  uri: string,
  pathKind: OpenInEditorOptions["pathKind"],
  failureLogMessage: string,
): Promise<OpenInEditorResult> {
  // 远程文件和目录以前共用 folder URI，导致文件路径被 VS Code 当成目录；
  // pathKind 只决定 CLI URI 参数，远端路径与 workspace identity 保持原样。
  const args = [pathKind === "file" ? "--file-uri" : "--folder-uri", uri];
  const cliCommand = resolveBundledVSCodeCliPath(appPath, command) ?? command;
  if (cliCommand) {
    try {
      await execFileAsync(cliCommand, args);
      return { success: true };
    } catch (error) {
      if (process.platform === "win32") {
        return openWindowsEditor(editorId, appPath, args, error);
      }

      try {
        await execFileAsync("open", ["-a", appPath, "--args", ...args]);
        return { success: true };
      } catch (fallbackError) {
        logger.warn(failureLogMessage, {
          editorId,
          path,
          args,
          error: stringifyError(error),
          fallbackError: stringifyError(fallbackError),
        });
        return { success: false, error: stringifyError(fallbackError) };
      }
    }
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync(appPath, args);
    } else {
      await execFileAsync("open", ["-a", appPath, "--args", ...args]);
    }
    return { success: true };
  } catch (error) {
    logger.warn(failureLogMessage, {
      editorId,
      path,
      args,
      error: stringifyError(error),
    });
    return { success: false, error: stringifyError(error) };
  }
}

async function openVSCodeRemoteSshFolder(
  editorId: string,
  appPath: string,
  command: string | null,
  path: string,
  remoteTarget: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
  pathKind: OpenInEditorOptions["pathKind"],
): Promise<OpenInEditorResult> {
  return openVSCodeRemoteUri(
    editorId,
    appPath,
    command,
    path,
    await buildVSCodeSshFolderUri(path, remoteTarget),
    pathKind,
    "[editors] 打开 VS Code 远程工作区失败",
  );
}

async function openVSCodeRemoteWslFolder(
  editorId: string,
  appPath: string,
  command: string | null,
  path: string,
  remoteTarget: Extract<OpenInEditorRemoteTarget, { kind: "wsl" }>,
  pathKind: OpenInEditorOptions["pathKind"],
): Promise<OpenInEditorResult> {
  const folderUri = await buildVSCodeWslFolderUri(path, remoteTarget);
  if (!folderUri.uri) {
    return { success: false, error: folderUri.error ?? "invalid WSL folder URI" };
  }

  return openVSCodeRemoteUri(
    editorId,
    appPath,
    command,
    path,
    folderUri.uri,
    pathKind,
    "[editors] 打开 VS Code WSL 工作区失败",
  );
}

async function openZedTarget(
  appPath: string,
  command: string | null,
  path: string,
  targetArg: string,
  failureLogMessage: string,
): Promise<OpenInEditorResult> {
  const args = [targetArg];
  const cliCommand = resolveBundledZedCliPath(appPath, command) ?? command;
  if (cliCommand) {
    try {
      await execFileAsync(cliCommand, args);
      return { success: true };
    } catch (error) {
      if (process.platform === "win32") {
        return openWindowsEditor("zed", appPath, args, error);
      }

      try {
        await execFileAsync("open", ["-a", appPath, ...args]);
        return { success: true };
      } catch (fallbackError) {
        logger.warn(failureLogMessage, {
          editorId: "zed",
          path,
          args,
          error: stringifyError(error),
          fallbackError: stringifyError(fallbackError),
        });
        return { success: false, error: stringifyError(fallbackError) };
      }
    }
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync(appPath, args);
    } else {
      await execFileAsync("open", ["-a", appPath, ...args]);
    }
    return { success: true };
  } catch (error) {
    logger.warn(failureLogMessage, {
      editorId: "zed",
      path,
      args,
      error: stringifyError(error),
    });
    return { success: false, error: stringifyError(error) };
  }
}

async function openZedRemoteSshPath(
  appPath: string,
  command: string | null,
  path: string,
  remoteTarget: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
): Promise<OpenInEditorResult> {
  return openZedTarget(
    appPath,
    command,
    path,
    await buildZedSshUri(path, remoteTarget),
    "[editors] 打开 Zed 远程工作区失败",
  );
}

async function openZedRemoteWslPath(
  appPath: string,
  command: string | null,
  path: string,
  remoteTarget: Extract<OpenInEditorRemoteTarget, { kind: "wsl" }>,
): Promise<OpenInEditorResult> {
  const distroName = await resolveWslDistroName(remoteTarget);
  if (!distroName) {
    return { success: false, error: "missing WSL distro for Zed" };
  }

  const [uncPath] = buildWslUncPathCandidates(path, distroName);
  if (!uncPath) {
    return { success: false, error: "invalid WSL UNC path for Zed" };
  }

  return openZedTarget(
    appPath,
    command,
    path,
    uncPath,
    "[editors] 打开 Zed WSL 工作区失败",
  );
}

async function openWslPathInExplorer(
  appPath: string,
  path: string,
  remoteTarget: Extract<OpenInEditorRemoteTarget, { kind: "wsl" }>,
  pathKind: OpenInEditorOptions["pathKind"],
): Promise<OpenInEditorResult> {
  const distroName = await resolveWslDistroName(remoteTarget);
  if (!distroName) {
    return { success: false, error: "missing WSL distro for Windows Explorer" };
  }

  const candidates = buildWslUncPathCandidates(path, distroName);
  let lastError = "";
  for (const candidate of candidates) {
    const args = pathKind === "file" ? ["/select,", candidate] : [candidate];
    try {
      await execFileAsync(appPath, args);
      return { success: true };
    } catch (error) {
      // explorer.exe 会把请求委托给已运行的资源管理器进程，窗口已经打开时
      // 子进程仍可能以 code=1 退出。不能只按数字退出码吞错；必须同时核对 Windows
      // 平台、进程状态、stderr 和本次完整命令，避免路径/权限/UNC 错误跳过候选 fallback。
      if (await isDelegatedWindowsExplorerExit(error, appPath, args, candidate)) {
        return { success: true };
      }
      lastError = stringifyError(error);
    }
  }

  logger.warn("[editors] 打开 WSL 工作区资源管理器失败", {
    path,
    candidates,
    error: lastError,
  });
  return { success: false, error: lastError || "failed to open WSL path in Explorer" };
}

async function openWindowsEditor(
  editorId: string,
  appPath: string,
  args: string[],
  cliError?: unknown,
): Promise<OpenInEditorResult> {
  const cliJsPath = isVSCodeEditor(editorId) ? resolveWindowsVSCodeCliJsPath(appPath) : null;
  if (cliJsPath) {
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      };
      delete env.NODE_OPTIONS;
      delete env.NODE_REPL_EXTERNAL_MODULE;
      await execFileWithEnvAsync(appPath, [cliJsPath, ...args], env);
      return { success: true };
    } catch {
      // cli.js 失败时继续回退到直接调用 appPath
    }
  }

  try {
    await execFileAsync(appPath, args);
    return { success: true };
  } catch (error) {
    logger.warn("[editors] 打开 Windows 编辑器失败", {
      editorId,
      args,
      appPath,
      error: stringifyError(error),
      cliError: cliError === undefined ? undefined : stringifyError(cliError),
    });
    return { success: false, error: stringifyError(error) };
  }
}

/**
 * 用指定编辑器打开路径。
 */
export async function openInEditor(
  editorId: string,
  path: string,
  options?: OpenInEditorOptions,
): Promise<OpenInEditorResult> {
  const def = getEditorDefsForCurrentPlatform().find((editor) => editor.id === editorId);
  if (!def) {
    return { success: false, error: `unknown editor: ${editorId}` };
  }

  const fileApp = getFileApplicationDefs().find((app) => app.id === editorId);
  if (fileApp) {
    // 文档应用只能消费本机匹配类型的文件，不能把远端路径当成本机路径打开。
    if (
      options?.remoteTarget ||
      options?.pathKind === "directory" ||
      !(process.platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path)) ||
      !matchesFileApplication(fileApp, path)
    ) {
      return { success: false, error: "unsupported file application target" };
    }
    // renderer 的 pathKind 不能证明文件存在；异步 stat 避免阻塞主进程。
    if (!(await stat(path).catch(() => null))?.isFile())
      return { success: false, error: "unsupported file application target" };
    const applicationPath = await resolveFileApplicationPath(fileApp);
    if (!applicationPath) return { success: false, error: "application is not installed" };
    try {
      if (process.platform === "darwin") {
        await execFileAsync("open", [
          "-a",
          applicationPath,
          path,
          ...(fileApp.launchArgs?.length ? ["--args", ...fileApp.launchArgs] : []),
        ]);
      } else {
        // 阅读器可能长时间运行并输出日志；不能用 execFile 缓冲输出或等待其退出。
        const child = spawn(applicationPath, [...(fileApp.launchArgs ?? []), path], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        child.unref();
      }
      return { success: true };
    } catch (error) {
      logger.warn("[editors] 打开文件应用失败", { editorId, path, error: stringifyError(error) });
      return { success: false, error: stringifyError(error) };
    }
  }

  const appPath = resolveEditorDefAppPath(def) ?? def.appPath;
  if (options?.remoteTarget?.kind === "ssh" && isVSCodeEditor(editorId)) {
    // SSH 工作区的 workspacePath 是远端文件系统路径，不能按本机路径执行 `code /root/...`。
    // VS Code Remote-SSH 需要 folder URI 才会连接对应 SSH Host 并打开远端目录。
    return openVSCodeRemoteSshFolder(
      editorId,
      appPath,
      def.command,
      path,
      options.remoteTarget,
      options.pathKind,
    );
  }

  if (options?.remoteTarget?.kind === "ssh" && editorId === "zed") {
    return openZedRemoteSshPath(appPath, def.command, path, options.remoteTarget);
  }

  if (options?.remoteTarget?.kind === "wsl" && isVSCodeEditor(editorId)) {
    // WSL 工作区的 workspacePath 是 Linux 路径，不能直接传给 Windows 侧 `code`。
    // VS Code Remote-WSL 需要 folder URI，才能在指定 distro 内打开同一个 Linux 目录。
    return openVSCodeRemoteWslFolder(
      editorId,
      appPath,
      def.command,
      path,
      options.remoteTarget,
      options.pathKind,
    );
  }

  if (options?.remoteTarget?.kind === "wsl" && editorId === "zed") {
    return openZedRemoteWslPath(appPath, def.command, path, options.remoteTarget);
  }

  if (options?.remoteTarget?.kind === "wsl" && editorId === "explorer") {
    // Windows 资源管理器无法理解 `/home/...` 这类 WSL 内部路径。
    // 仅在打开宿主应用的边界把路径转成 UNC，远端 host / agent 仍保留 Linux 路径语义。
    return openWslPathInExplorer(appPath, path, options.remoteTarget, options.pathKind);
  }

  const pathKind = detectPathKind(path);

  if (editorId === "finder") {
    if (pathKind === "file") {
      shell.showItemInFolder(path);
      return { success: true };
    }
    return openPathViaShell(path);
  }

  if (editorId === "explorer") {
    if (pathKind !== "file") {
      return openPathViaShell(path);
    }

    // Explorer 已委托打开请求后仍可能非零退出，按退出码回退会重复打开窗口。
    // 本地文件直接使用系统定位 API，只发出一次打开所在目录并选中文件的请求。
    shell.showItemInFolder(path);
    return { success: true };
  }

  if (def.command) {
    try {
      await execFileAsync(def.command, [path]);
      return { success: true };
    } catch (error) {
      if (process.platform === "win32") {
        return openWindowsEditor(editorId, appPath, [path], error);
      }

      try {
        await execFileAsync("open", ["-a", appPath, path]);
        return { success: true };
      } catch (fallbackError) {
        logger.warn("[editors] 打开编辑器失败", {
          editorId,
          path,
          error: stringifyError(error),
          fallbackError: stringifyError(fallbackError),
        });
        return { success: false, error: stringifyError(fallbackError) };
      }
    }
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync(appPath, [path]);
    } else {
      await execFileAsync("open", ["-a", appPath, path]);
    }
    return { success: true };
  } catch (error) {
    logger.warn("[editors] 打开编辑器失败", {
      editorId,
      path,
      error: stringifyError(error),
    });
    return { success: false, error: stringifyError(error) };
  }
}
