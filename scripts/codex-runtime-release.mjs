import { execFile } from "node:child_process";
import { lstat, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { sha256File } from "./codex-runtime.mjs";

const exec = promisify(execFile);
const formats = { darwin: [".dmg", ".zip"], linux: [".AppImage", ".deb"], win32: [".exe"] };
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
    tag: `codez-codex-build-${env.GITHUB_RUN_ID}-${env.GITHUB_SHA.slice(0, 12)}`,
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
  for (const [os, extensions] of Object.entries(formats)) {
    for (const arch of ["x64", "arm64"]) {
      const key = `${os}-${arch}`;
      const matches = folders.filter((entry) =>
        new RegExp(`^codez-codex-${key}-(un)?signed$`).test(entry.name),
      );
      if (matches.length !== 1 || !matches[0].isDirectory())
        throw new Error(`Missing or ambiguous target: ${key}`);
      const dir = join(directory, matches[0].name);
      const checksum = join(dir, `SHA256SUMS-${key}.txt`);
      await asset(checksum);
      const lines = (await readFile(checksum, "utf8")).trim().split("\n");
      if (lines.length !== extensions.length) throw new Error(`Incomplete installer set: ${key}`);
      const foundExtensions = new Set();
      const manifest = [];
      const archNames = arch === "x64" ? "x64|x86_64|amd64" : "arm64|aarch64";
      const targetPattern = new RegExp(
        `-${platformNames[os]}-(?:${archNames})(?:_TEST)?(?:-unsigned)?\\.`,
      );
      for (const line of lines) {
        const match = /^([a-f0-9]{64})  (Codez[ .]Codex-[A-Za-z0-9 ._+-]+)$/.exec(line);
        if (!match || !targetPattern.test(match[2]))
          throw new Error(`Unsafe or foreign checksum entry: ${key}`);
        const [, expected, originalName] = match;
        const extension = extensions.find((ext) => originalName.endsWith(ext));
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
      result.push(await asset(checksum));
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
    const notes = [
      "Independent community Codez Codex build; not an official OpenAI product.",
      `Source commit: ${sha}. Source ref: ${env.GITHUB_REF}.`,
      `Build evidence: https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
      "All six native desktop builds and Codex smoke checks passed. Installers include pinned Codex and verified remote components. SHA256SUMS files accompany every target.",
      "Unsigned installers are labelled accordingly. Automatic application updates remain disabled. Live external SSH/WSL, real account OAuth and plugin installs are not certified by native package smoke tests.",
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
        `name=Codez Codex build ${env.GITHUB_RUN_ID} (${sha.slice(0, 12)})`,
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
