import { spawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { codexWorkspaceRoot, resolveCodexTarget, stageCodexBinary } from "./codex-runtime.mjs";

export async function generateCodexSchema(
  output = "packages/codex-bridge/dist/schema",
  { json = false } = {},
) {
  const target = resolveCodexTarget();
  if (target.os !== process.platform || target.arch !== process.arch)
    throw new Error("Schema generation requires a verified native host binary");
  const root = await realpath(codexWorkspaceRoot);
  const destination = resolve(root, output);
  const inside = (path) => {
    const segment = relative(root, path);
    return (
      segment !== "" &&
      segment !== ".." &&
      !segment.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(segment)
    );
  };
  if (!inside(destination)) throw new Error("Schema output must be inside ZCode");
  // 先检查最近的真实父目录，防止软链接把生成结果写入邻居仓库。
  let parent = destination;
  while (true) {
    try {
      const actual = await realpath(parent);
      if (actual !== root && !inside(actual))
        throw new Error("Schema output escapes ZCode through a symlink");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      parent = resolve(parent, "..");
    }
  }
  const binary = await stageCodexBinary({ target });
  await mkdir(destination, { recursive: true });
  await new Promise((accept, reject) => {
    const child = spawn(
      binary,
      [
        "app-server",
        json ? "generate-json-schema" : "generate-ts",
        "--experimental",
        "--out",
        destination,
      ],
      {
        cwd: root,
        shell: false,
        stdio: "inherit",
        timeout: 120_000,
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? accept()
        : reject(new Error(`Codex schema generation failed (${code ?? signal})`)),
    );
  });
  return destination;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length > 2 || (args[1] && args[1] !== "--json"))
    throw new Error(
      "Usage: node scripts/codex-runtime-schema.mjs [ZCode-relative-output] [--json]",
    );
  console.log(await generateCodexSchema(args[0], { json: args[1] === "--json" }));
}
