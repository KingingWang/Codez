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

export function buildManifestFromLatestRelease(release) {
  // fork 的 release 可能正处于上传中途：六个目标资产必须齐全且带 GitHub digest，
  // 否则 fail closed，等下一次构建而不是把半成品清单发布出去。
  if (!CODEX_TAG_PATTERN.test(release?.tag_name ?? ""))
    throw new Error(`Unexpected Codex release tag: ${release?.tag_name ?? "<missing>"}`);
  const assets = {};
  for (const [key, name] of Object.entries(TARGET_ASSET_NAMES)) {
    const asset = Array.isArray(release.assets)
      ? release.assets.find((entry) => entry?.name === name)
      : undefined;
    const digest = typeof asset?.digest === "string" ? asset.digest : "";
    const sha256 = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : "";
    if (
      !asset ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0
    )
      throw new Error(`Codex release ${release.tag_name} is missing a verified asset: ${name}`);
    assets[key] = { name, size: asset.size, sha256 };
  }
  return { schemaVersion: 1, repository: CODEX_REPOSITORY, tag: release.tag_name, assets };
}

export async function resolveLatestCodexManifest(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = options.attempts ?? 3;
  const retryDelay = options.retryDelay ?? ((attempt) => new Promise((done) => setTimeout(done, attempt * 1500)));
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
      return buildManifestFromLatestRelease(await response.json());
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
  console.log(`[codex-manifest] latest fork Codex release: ${manifest.tag} -> ${output}`);
}
