import { readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { codexWorkspaceRoot, resolveCodexTarget, sha256File } from "./codex-runtime.mjs";

/**
 * 每个构建目标进入 release 的完整资产模型：安装包 + 差分 blockmap + per-arch channel yml。
 * channel yml 命名与 app-builder-lib updateInfoBuilder.getUpdateInfoFileName 保持一致：
 * windows 无平台后缀，mac 追加 -mac，linux 追加 -linux 且非 x64 再追加 -<arch>
 * （linux arm64 因此是 arm64-latest-linux-arm64.yml）。运行时 electron-updater 用烘焙进
 * app-update.yml 的 channel 加同一套平台后缀取回该文件，两边规则必须同步修改。
 */
export function resolveCodexUpdaterAssetPlan(os, arch) {
  const channelSuffix = { darwin: "-mac", linux: "-linux", win32: "" }[os];
  const linuxArchSuffix = os === "linux" && arch !== "x64" ? `-${arch}` : "";
  return {
    installers: { darwin: [".dmg", ".zip"], linux: [".AppImage", ".deb"], win32: [".exe"] }[os],
    // electron-builder 只为可差分更新的产物（dmg/zip/nsis/AppImage）生成 blockmap，deb 没有。
    blockmapped: { darwin: [".dmg", ".zip"], linux: [".AppImage"], win32: [".exe"] }[os],
    channelYml: `${arch}-latest${channelSuffix}${linuxArchSuffix}.yml`,
  };
}

export async function writeCodexArtifactChecksums(directory) {
  const target = resolveCodexTarget();
  const plan = resolveCodexUpdaterAssetPlan(target.os, target.arch);
  const platformName = { darwin: "mac", win32: "win", linux: "linux" }[target.os];
  // electron-builder 的 ${arch} 在 AppImage/deb 中分别展开为 x86_64/amd64，不能只认 Node 的 x64。
  const archNames = target.arch === "x64" ? "x64|x86_64|amd64" : "arm64|aarch64";
  const targetName = new RegExp(`-${platformName}-(?:${archNames})(?:_TEST)?(?:-unsigned)?\\.`);
  const signed = process.env.CODEZ_CODEX_SIGNED === "1";
  const directoryFiles = await readdir(directory);
  const installers = directoryFiles
    .filter(
      (file) =>
        file.startsWith("Codez-") &&
        targetName.test(file) &&
        !file.endsWith(".blockmap") &&
        file.includes("-unsigned.") !== signed &&
        plan.installers.some((ext) => file.endsWith(ext)),
    )
    .sort();
  for (const ext of plan.installers)
    if (!installers.some((file) => file.endsWith(ext)))
      throw new Error(`Missing ${target.key} installer ${ext}`);
  const files = [...installers];
  // blockmap 是更新器的差分数据源，必须与安装包同批发布；缺失会让差分下载静默退化为全量。
  for (const ext of plan.blockmapped) {
    const installer = installers.find((file) => file.endsWith(ext));
    const blockmap = `${installer}.blockmap`;
    if (!directoryFiles.includes(blockmap))
      throw new Error(`Missing ${target.key} updater blockmap ${blockmap}`);
    files.push(blockmap);
  }
  // channel yml 不以 Codez- 开头，只接受 app-builder-lib 为本目标生成的精确文件名，
  // 其余 yml（如 builder-debug.yml）一律不纳入校验清单。
  if (!directoryFiles.includes(plan.channelYml))
    throw new Error(`Missing ${target.key} updater metadata ${plan.channelYml}`);
  files.push(plan.channelYml);
  const lines = [];
  for (const file of files)
    lines.push(`${await sha256File(join(directory, file))}  ${basename(file)}`);
  const output = join(directory, `SHA256SUMS-${target.key}.txt`);
  await writeFile(output, `${lines.join("\n")}\n`);
  console.log(`[codex-distribution] ${files.length} asset checksums: ${output}`);
  return output;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await writeCodexArtifactChecksums(
    resolve(codexWorkspaceRoot, process.argv[2] ?? "packages/desktop/dist"),
  );
}
