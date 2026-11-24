import { execFile } from "node:child_process";
import { promisify } from "node:util";
// Windows 入口是 shim（codez-soffice.exe），不经 shell 也能按 PATH 找到。
const { stdout } = await promisify(execFile)("codez-soffice", ["--fixture-location"]);
console.log(
  JSON.stringify({
    executable: stdout.trim(),
    available: process.env.CODEZ_PREINSTALLED_TOOLS_AVAILABLE,
  }),
);
