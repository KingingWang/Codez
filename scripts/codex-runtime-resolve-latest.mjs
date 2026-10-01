import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CODEX_REPOSITORY = "KingingWang/codex";
const CODEX_TAG_PATTERN = /^codex-\d{8}-\d{6}$/;
const TARGET_ASSET_NAMES = {
  "darwin-x64": "codex-macos-x86_64",
  "darwin-arm64": "codex-macos-aarch64",
  "linux-x64": "codex-linux-x86_64-musl",
  "linux-arm64": "codex-linux-aarch64-musl",
  "win32-x64": "codex-windows-x86_64.exe",
  "win32-arm64": "codex-windows-aarch64.exe",
};

class MissingCodexReleaseAssetError extends Error {}

export function buildManifestFromLatestRelease(release) {
  // 六目标必须来自同一正式 release；缺目标与已上传资产校验异常不能混为一谈。
  if (!CODEX_TAG_PATTERN.test(release?.tag_name ?? ""))
    throw new Error(`Unexpected Codex release tag: ${release?.tag_name ?? "<missing>"}`);
  if (!Array.isArray(release.assets))
    throw new Error(`Codex release ${release.tag_name} has a malformed asset list`);
  const assets = {};
  for (const [key, name] of Object.entries(TARGET_ASSET_NAMES)) {
    const asset = release.assets.find((entry) => entry?.name === name);
    if (!asset)
      throw new MissingCodexReleaseAssetError(
        `Codex release ${release.tag_name} is missing a verified asset: ${name}`,
      );
    const digest = typeof asset?.digest === "string" ? asset.digest : "";
    const sha256 = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : "";
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0)
      throw new Error(`Codex release ${release.tag_name} is missing a verified asset: ${name}`);
    assets[key] = { name, size: asset.size, sha256 };
  }
  return { schemaVersion: 1, repository: CODEX_REPOSITORY, tag: release.tag_name, assets };
}

export async function resolveLatestCodexManifest(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = options.attempts ?? 3;
  const retryDelay =
    options.retryDelay ?? ((attempt) => new Promise((done) => setTimeout(done, attempt * 1500)));
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await retryDelay(attempt);
    try {
      const response = await fetchImpl(
        `https://api.github.com/repos/${CODEX_REPOSITORY}/releases/latest`,
        { headers },
      );
      if (!response.ok)
        throw new Error(`GitHub latest release lookup failed: HTTP ${response.status}`);
      const latest = await response.json();
      try {
        return buildManifestFromLatestRelease(latest);
      } catch (error) {
        if (!(error instanceof MissingCodexReleaseAssetError)) throw error;
      }
      const listResponse = await fetchImpl(
        `https://api.github.com/repos/${CODEX_REPOSITORY}/releases?per_page=10`,
        { headers },
      );
      if (!listResponse.ok)
        throw new Error(`GitHub release list lookup failed: HTTP ${listResponse.status}`);
      const releases = await listResponse.json();
      if (!Array.isArray(releases))
        throw new Error("GitHub release list lookup returned a malformed response");
      const stable = releases
        .slice(0, 10)
        .filter((release) => release?.draft === false && release.prerelease === false);
      const latestIndex = stable.findIndex((release) => release.tag_name === latest.tag_name);
      if (latestIndex < 0)
        throw new Error(`GitHub release list no longer contains latest ${latest.tag_name}`);
      // 列表重读可捕获刚上传完成的最新版本；仅缺资产可向更早完整版本回退。
      for (const release of stable.slice(latestIndex)) {
        try {
          return buildManifestFromLatestRelease(release);
        } catch (error) {
          if (!(error instanceof MissingCodexReleaseAssetError)) throw error;
        }
      }
      throw new Error(`No complete verified fork Codex release in the latest ${releases.length}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const output = resolve(process.argv[2] ?? "codex-manifest.json");
  const manifest = await resolveLatestCodexManifest({
    token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[codex-manifest] latest complete fork Codex release: ${manifest.tag} -> ${output}`);
}
