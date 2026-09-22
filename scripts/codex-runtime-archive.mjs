import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const modes = { create: "-czf", extract: "-xzf", list: "-tzf" };

export function createCodexTarInvocation({
  mode,
  archivePath,
  directory,
  entries = [],
  stripComponents = 0,
  platform = process.platform,
}) {
  if (!Object.hasOwn(modes, mode)) throw new Error("Unsupported Codex tar mode");
  if (!Number.isSafeInteger(stripComponents) || stripComponents < 0)
    throw new Error("Invalid tar strip-components count");
  const paths = platform === "win32" ? win32 : posix;
  const archive = paths.resolve(archivePath);
  const cwd = paths.dirname(archive);
  // Windows Git Bash 的 GNU tar 把 -f C:\\... 当远程主机；归档固定为 cwd 下的 ./文件名。
  // 不使用 GNU 专有 --force-local，兼容 macOS/Windows bsdtar，且不经 shell 拼接参数。
  const args = [modes[mode], `./${paths.basename(archive)}`];
  if (directory) {
    const operand = paths.relative(cwd, paths.resolve(directory)) || ".";
    args.push("-C", platform === "win32" ? operand.replaceAll("\\", "/") : operand);
  }
  if (stripComponents) args.push(`--strip-components=${stripComponents}`);
  args.push("--", ...entries);
  return { command: "tar", args, options: { cwd, shell: false } };
}

export async function runCodexTar(options) {
  const { command, args, options: spawnOptions } = createCodexTarInvocation(options);
  return run(command, args, spawnOptions);
}
