import { execFile } from "node:child_process";
import { lstat, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { sha256File } from "./codex-runtime.mjs";
import { resolveCodexUpdaterAssetPlan } from "./codex-runtime-artifacts.mjs";

const exec = promisify(execFile);
const platformNames = { darwin: "mac", linux: "linux", win32: "win" };

export function releaseIdentity(env) {
  if (env.GITHUB_REPOSITORY !== "KingingWang/Codez")
    throw new Error("Unexpected release repository");
  if (!["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME))
    throw new Error("Event cannot publish");
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""))
    throw new Error("Release requires exact commit");
  if (!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "")) throw new Error("Invalid workflow run ID");
  if (!/^refs\/(heads|tags)\/.+/.test(env.GITHUB_REF ?? "")) throw new Error("Invalid release ref");
  return {
    repository: env.GITHUB_REPOSITORY,
    sha: env.GITHUB_SHA,
    tag: `codez-build-${env.GITHUB_RUN_ID}-${env.GITHUB_SHA.slice(0, 12)}`,
    prerelease: env.GITHUB_REF !== "refs/heads/main",
  };
}

async function asset(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Not a nonempty regular asset: ${path}`);
  return { path, name: basename(path), size: stat.size, sha256: await sha256File(path) };
}

export async function collectReleaseAssets(directory) {
  const folders = await readdir(directory, { withFileTypes: true });
  const result = [];
  const seen = new Set();
  for (const os of Object.keys(platformNames)) {
    for (const arch of ["x64", "arm64"]) {
      const key = `${os}-${arch}`;
      // 资产模型与 scripts/codex-runtime-artifacts.mjs 同源：安装包 + 差分 blockmap
      // + per-arch channel yml 一个都不能少，release 只接受这个精确集合。
      const plan = resolveCodexUpdaterAssetPlan(os, arch);
      const expectedCount = plan.installers.length + plan.blockmapped.length + 1;
      const matches = folders.filter((entry) =>
        new RegExp(`^codez-${key}-(un)?signed$`).test(entry.name),
      );
      if (matches.length !== 1 || !matches[0].isDirectory())
        throw new Error(`Missing or ambiguous target: ${key}`);
      const dir = join(directory, matches[0].name);
      const checksum = join(dir, `SHA256SUMS-${key}.txt`);
      await asset(checksum);
      const lines = (await readFile(checksum, "utf8")).trim().split("\n");
      if (lines.length !== expectedCount) throw new Error(`Incomplete installer set: ${key}`);
      const foundExtensions = new Set();
      const manifest = [];
      const archNames = arch === "x64" ? "x64|x86_64|amd64" : "arm64|aarch64";
      const targetPattern = new RegExp(
        `-${platformNames[os]}-(?:${archNames})(?:_TEST)?(?:-unsigned)?\\.`,
      );
      for (const line of lines) {
        const match = /^([a-f0-9]{64})  ([A-Za-z0-9 ._+-]+)$/.exec(line);
        if (!match) throw new Error(`Unsafe or foreign checksum entry: ${key}`);
        const [, expected, originalName] = match;
        let extension;
        if (originalName === plan.channelYml) {
          // channel yml 不以 Codez- 开头；只接受本目标的精确文件名，其余 yml 一律视为外来条目。
          extension = ".yml";
        } else {
          if (!originalName.startsWith("Codez-") || !targetPattern.test(originalName))
            throw new Error(`Unsafe or foreign checksum entry: ${key}`);
          extension =
            plan.installers.find((ext) => originalName.endsWith(ext)) ??
            plan.blockmapped
              .map((ext) => `${ext}.blockmap`)
              .find((ext) => originalName.endsWith(ext));
        }
        if (!extension || foundExtensions.has(extension))
          throw new Error(`Duplicate or unexpected installer: ${key}`);
        foundExtensions.add(extension);
        const original = await asset(join(dir, originalName));
        if (original.sha256 !== expected)
          throw new Error(`Installer checksum mismatch: ${originalName}`);
        // GitHub 会将资源名中的空格替换为点；先统一名称和校验清单，避免下载后无法校验。
        const publicName = originalName.replaceAll(" ", ".");
        if (seen.has(publicName)) throw new Error(`Duplicate public asset: ${publicName}`);
        seen.add(publicName);
        const path = join(dir, publicName);
        if (path !== original.path) {
          try {
            await lstat(path);
            throw new Error(`Public asset name collision: ${publicName}`);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          await rename(original.path, path);
        }
        result.push({ ...original, name: publicName, path });
        manifest.push(`${expected}  ${publicName}`);
      }
      await writeFile(checksum, `${manifest.join("\n")}\n`);
      // 校验清单只在流水线内用于完整性校验，不上传到 Release，避免冗余资产。
    }
  }
  return result;
}

function verifyUploaded(release, assets, sha) {
  if (release.target_commitish !== sha)
    throw new Error("Release target does not match built commit");
  if (release.assets.length !== assets.length)
    throw new Error("Release asset set is incomplete or unexpected");
  for (const file of assets) {
    const matches = release.assets.filter((uploaded) => uploaded.name === file.name);
    if (
      matches.length !== 1 ||
      matches[0].state !== "uploaded" ||
      matches[0].size !== file.size ||
      matches[0].digest !== `sha256:${file.sha256}`
    )
      throw new Error(`Uploaded asset integrity mismatch: ${file.name}`);
  }
}

async function findRelease(run, repository, tag) {
  try {
    return JSON.parse(await run(["api", `repos/${repository}/releases/tags/${tag}`]));
  } catch (error) {
    if (!/HTTP 404/.test(error.message)) throw error;
  }
  // 按 tag 的 REST 接口只返回已发布版本；草稿必须从有写权限的分页列表定位。
  const pages = JSON.parse(
    await run(["api", `repos/${repository}/releases?per_page=100`, "--paginate", "--slurp"]),
  );
  const matches = pages.flat().filter((release) => release.tag_name === tag);
  if (matches.length > 1) throw new Error("Ambiguous release identity");
  return matches[0];
}

const uploadAttempts = 3;
const defaultRetryDelay = (attempt) => new Promise((done) => setTimeout(done, attempt * 2_000));

/** 大体积安装包上传易被网络中断；--clobber 让重试幂等，避免整条原生流水线重跑。 */
async function uploadReleaseAsset(run, repository, tag, file, retryDelay) {
  let failure;
  for (let attempt = 1; attempt <= uploadAttempts; attempt += 1) {
    try {
      await run(["release", "upload", tag, file.path, "--repo", repository, "--clobber"]);
      return;
    } catch (error) {
      failure = error;
      if (attempt < uploadAttempts) await retryDelay(attempt);
    }
  }
  throw failure;
}

export async function publishCodexRelease({
  directory,
  env = process.env,
  run = async (args) => (await exec("gh", args, { maxBuffer: 8 * 1024 * 1024 })).stdout,
  retryDelay = defaultRetryDelay,
}) {
  const identity = releaseIdentity(env);
  const assets = await collectReleaseAssets(directory);
  const { repository, sha, tag, prerelease } = identity;
  let release = await findRelease(run, repository, tag);
  if (release && release.target_commitish !== sha)
    throw new Error("Release target does not match built commit");
  if (release && !release.draft) {
    verifyUploaded(release, assets, sha);
    console.log(`[codex-release] Already published and verified: ${tag}`);
    return identity;
  }
  if (!release) {
    // 发布说明里标注本次内置的 Codex 运行时版本，方便追溯；清单缺失时跳过不阻塞发布。
    let codexRuntimeNote =
      "Installers bundle the fork's latest verified Codex release and remote components.";
    try {
      const codexManifest = JSON.parse(
        await readFile(join(directory, "codez-manifest", "codex-manifest.json"), "utf8"),
      );
      if (/^codex-\d{8}-\d{6}$/.test(codexManifest?.tag ?? ""))
        codexRuntimeNote = `Installers bundle Codex runtime ${codexManifest.tag} (latest KingingWang/codex release at build time) and verified remote components.`;
    } catch {
      // 清单缺失或损坏不影响发布；资产完整性由 SHA256SUMS 校验兜底。
    }
    const notes = [
      "Independent community Codez build; not an official OpenAI product.",
      `Source commit: ${sha}. Source ref: ${env.GITHUB_REF}.`,
      `Build evidence: https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
      `All six native desktop builds and Codex smoke checks passed. ${codexRuntimeNote} SHA256 checksums are verified before publication.`,
      "Unsigned installers are labelled accordingly. Installed Codex builds auto-update from this release once it is published and marked Latest; updates are verified against the SHA512 checksums in the release updater metadata and are not code-signature gated. Builds older than the first updater-enabled release cannot discover it and must be installed manually once. Live external SSH/WSL, real account OAuth and plugin installs are not certified by native package smoke tests.",
    ].join("\n\n");
    // 创建接口直接返回权威对象。草稿刚创建时按 tag 的接口必然 404，分页列表也可能
    // 短暂不可见；重新查询会把一次成功的创建误判成身份不明，并留下一个空草稿。
    release = JSON.parse(
      await run([
        "api",
        "--method",
        "POST",
        `repos/${repository}/releases`,
        "-f",
        `tag_name=${tag}`,
        "-f",
        `target_commitish=${sha}`,
        "-F",
        "draft=true",
        "-F",
        `prerelease=${prerelease}`,
        "-f",
        "make_latest=false",
        "-f",
        `name=Codez build ${env.GITHUB_RUN_ID} (${sha.slice(0, 12)})`,
        "-f",
        `body=${notes}`,
      ]),
    );
  }
  if (
    !Number.isSafeInteger(release?.id) ||
    release.id <= 0 ||
    release.target_commitish !== sha ||
    !release.draft
  )
    throw new Error("Could not verify draft identity");
  for (const file of assets) {
    console.log(`[codex-release] Upload ${file.name}`);
    await uploadReleaseAsset(run, repository, tag, file, retryDelay);
  }
  release = JSON.parse(await run(["api", `repos/${repository}/releases/${release.id}`]));
  verifyUploaded(release, assets, sha);
  // 较早 push 可能较晚完成；仅当前 main 结果有资格更新 Latest，其他结果仍公开保留。
  const latest =
    !prerelease && JSON.parse(await run(["api", `repos/${repository}/commits/main`])).sha === sha;
  await run([
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    `--prerelease=${prerelease}`,
    `--latest=${latest}`,
  ]);
  console.log(`[codex-release] Published: ${tag}`);
  return identity;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await publishCodexRelease({ directory: resolve(process.argv[2] ?? "artifacts") });
}
