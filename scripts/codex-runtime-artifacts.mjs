import { readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { codexWorkspaceRoot, resolveCodexTarget, sha256File } from "./codex-runtime.mjs";

export async function writeCodexArtifactChecksums(directory) {
  const target = resolveCodexTarget();
  const extensions = { darwin: [".dmg", ".zip"], linux: [".AppImage", ".deb"], win32: [".exe"] }[
    target.os
  ];
  const platformName = { darwin: "mac", win32: "win", linux: "linux" }[target.os];
  // electron-builder 的 ${arch} 在 AppImage/deb 中分别展开为 x86_64/amd64，不能只认 Node 的 x64。
  const archNames = target.arch === "x64" ? "x64|x86_64|amd64" : "arm64|aarch64";
  const targetName = new RegExp(`-${platformName}-(?:${archNames})(?:_TEST)?(?:-unsigned)?\\.`);
  const signed = process.env.CODEZ_CODEX_SIGNED === "1";
  const files = (await readdir(directory))
    .filter(
      (file) =>
        file.startsWith("Codez-") &&
        targetName.test(file) &&
        file.includes("-unsigned.") !== signed &&
        extensions.some((ext) => file.endsWith(ext)),
    )
    .sort();
  for (const ext of extensions)
    if (!files.some((file) => file.endsWith(ext)))
      throw new Error(`Missing ${target.key} installer ${ext}`);
  const lines = [];
  for (const file of files)
    lines.push(`${await sha256File(join(directory, file))}  ${basename(file)}`);
  const output = join(directory, `SHA256SUMS-${target.key}.txt`);
  await writeFile(output, `${lines.join("\n")}\n`);
  console.log(`[codex-distribution] ${files.length} installer checksums: ${output}`);
  return output;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await writeCodexArtifactChecksums(
    resolve(codexWorkspaceRoot, process.argv[2] ?? "packages/desktop/dist"),
  );
}
