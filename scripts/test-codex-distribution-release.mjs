import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectReleaseAssets,
  publishCodexRelease,
  releaseIdentity,
} from "./codex-runtime-release.mjs";

const sha = "a".repeat(40);
const env = {
  GITHUB_REPOSITORY: "KingingWang/Codez",
  GITHUB_SHA: sha,
  GITHUB_RUN_ID: "12345",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "push",
};
const extensions = { darwin: [".dmg", ".zip"], linux: [".AppImage", ".deb"], win32: [".exe"] };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isCreate = (args) =>
  args[0] === "api" && args[2] === "POST" && String(args[3]).endsWith("/releases");
const isList = (args) => args[0] === "api" && String(args[1]).endsWith("/releases?per_page=100");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [os, exts] of Object.entries(extensions))
    for (const arch of ["x64", "arm64"]) {
      const dir = join(root, `codez-${os}-${arch}-unsigned`);
      await mkdir(dir);
      const lines = [];
      for (const ext of exts) {
        const name = `Codez-3.14.0-${{ darwin: "mac", linux: "linux", win32: "win" }[os]}-${arch}-unsigned${ext}`;
        await writeFile(join(dir, name), name);
        lines.push(`${digest(name)}  ${name}`);
      }
      await writeFile(join(dir, `SHA256SUMS-${os}-${arch}.txt`), `${lines.join("\n")}\n`);
    }
  return root;
}

function fakeGithub({
  existing,
  failUpload = false,
  mainSha = sha,
  hideCreated = false,
  flakyUploads = 0,
} = {}) {
  const state = {
    release: existing ? { id: 123, tag_name: releaseIdentity(env).tag, ...existing } : undefined,
    calls: [],
    created: false,
    uploadAttempts: 0,
  };
  const run = async (args) => {
    state.calls.push(args);
    if (args[0] === "api" && args[1].includes("/releases/tags/")) {
      if (!state.release || state.release.draft) throw new Error("HTTP 404: Not Found");
      return JSON.stringify(state.release);
    }
    if (isList(args)) {
      assert.ok(args.includes("--paginate") && args.includes("--slurp"));
      // 复现真实故障：刚创建的草稿在分页列表里短暂不可见。
      const hidden = hideCreated && state.created;
      return JSON.stringify([
        [{ id: 99, tag_name: "unrelated", draft: true }],
        state.release && !hidden ? [state.release] : [],
      ]);
    }
    if (args[0] === "api" && args[1].endsWith("/releases/123"))
      return JSON.stringify(state.release);
    if (args[0] === "api" && args[1].endsWith("/commits/main"))
      return JSON.stringify({ sha: mainSha });
    if (isCreate(args)) {
      const fields = {};
      for (let index = 4; index < args.length; index += 2) {
        const separator = args[index + 1].indexOf("=");
        fields[args[index + 1].slice(0, separator)] = args[index + 1].slice(separator + 1);
      }
      assert.equal(fields.tag_name, releaseIdentity(env).tag);
      state.release = {
        id: 123,
        tag_name: fields.tag_name,
        draft: fields.draft === "true",
        prerelease: fields.prerelease === "true",
        target_commitish: fields.target_commitish,
        assets: [],
      };
      state.created = true;
      return JSON.stringify(state.release);
    }
    if (args[1] === "upload") {
      state.uploadAttempts += 1;
      if (failUpload) throw new Error("upload failed");
      // 模拟 CDN 连接重置：前若干次上传失败，之后 --clobber 重传必须成功。
      if (state.uploadAttempts <= flakyUploads) throw new Error("unexpected EOF");
      const file = args[3];
      const bytes = await readFile(file);
      const name = file.split(/[\\/]/).at(-1);
      state.release.assets = state.release.assets.filter((asset) => asset.name !== name);
      state.release.assets.push({
        name,
        size: bytes.length,
        digest: `sha256:${digest(bytes)}`,
        state: "uploaded",
      });
      return "uploaded";
    }
    if (args[1] === "edit") {
      state.release.draft = false;
      return "published";
    }
    throw new Error(`Unexpected gh args: ${JSON.stringify(args)}`);
  };
  return { state, run };
}

test("release identity is exact-commit/run-scoped and rejects PRs and foreign repositories", () => {
  assert.equal(releaseIdentity(env).tag, `codez-build-12345-${sha.slice(0, 12)}`);
  assert.equal(releaseIdentity({ ...env, GITHUB_REF: "refs/heads/feature" }).prerelease, true);
  for (const override of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REPOSITORY: "zai-org/ZCode" },
    { GITHUB_SHA: "main" },
    { GITHUB_RUN_ID: "../bad" },
  ])
    assert.throws(() => releaseIdentity({ ...env, ...override }));
});

test("all six targets yield ten installers and six matching public-name manifests", async (t) => {
  const assets = await collectReleaseAssets(await fixture(t));
  assert.equal(assets.length, 16);
  assert.ok(assets.every((asset) => !asset.name.includes(" ")));
  for (const asset of assets.filter((item) => item.name.startsWith("SHA256SUMS")))
    assert.match(await readFile(asset.path, "utf8"), /  Codez-/);
});

test("missing targets, corrupt content and traversal checksums fail before publication", async (t) => {
  for (const fault of ["missing", "corrupt", "traversal"]) {
    const root = await fixture(t);
    const dir = join(root, "codez-win32-arm64-unsigned");
    if (fault === "missing") await rm(dir, { recursive: true });
    if (fault === "corrupt")
      await writeFile(join(dir, "Codez-3.14.0-win-arm64-unsigned.exe"), "corrupt");
    if (fault === "traversal")
      await writeFile(
        join(dir, "SHA256SUMS-win32-arm64.txt"),
        `${"a".repeat(64)}  ../escape.exe\n`,
      );
    await assert.rejects(collectReleaseAssets(root));
  }
});

test("publish verifies all uploads before making release public and main Latest", async (t) => {
  const github = fakeGithub();
  await publishCodexRelease({ directory: await fixture(t), env, run: github.run });
  assert.equal(github.state.release.draft, false);
  assert.equal(github.state.release.assets.length, 16);
  assert.ok(github.state.calls.find(isCreate).includes(`target_commitish=${sha}`));
  assert.ok(github.state.calls.at(-1).includes("--latest=true"));
  assert.ok(github.state.calls.some((args) => args[1].endsWith("/releases/123")));
});

test("created draft identity survives release-list read-after-write lag", async (t) => {
  const github = fakeGithub({ hideCreated: true });
  await publishCodexRelease({ directory: await fixture(t), env, run: github.run });
  assert.equal(github.state.release.draft, false);
  assert.equal(github.state.release.assets.length, 16);
  // 身份必须来自创建接口的返回体；创建后不能再依赖一次可能滞后的列表查询。
  assert.equal(github.state.calls.filter(isList).length, 1);
});

test("upload failure stays draft, rerun resumes, published rerun never overwrites", async (t) => {
  const root = await fixture(t);
  const failure = fakeGithub({ failUpload: true });
  await assert.rejects(
    publishCodexRelease({
      directory: root,
      env,
      run: failure.run,
      retryDelay: async () => {},
    }),
    /upload failed/,
  );
  // 有界重试用尽后才失败，且绝不能提前公开草稿。
  assert.equal(failure.state.uploadAttempts, 3);
  assert.equal(failure.state.release.draft, true);
  assert.ok(!failure.state.calls.some((args) => args[1] === "edit"));
  const retry = fakeGithub({ existing: failure.state.release });
  await publishCodexRelease({ directory: root, env, run: retry.run });
  const rerun = fakeGithub({ existing: retry.state.release });
  await publishCodexRelease({ directory: root, env, run: rerun.run });
  assert.ok(
    !rerun.state.calls.some((args) => isCreate(args) || ["upload", "edit"].includes(args[1])),
  );
});

test("transient upload resets are retried and still fully verified", async (t) => {
  const github = fakeGithub({ flakyUploads: 2 });
  await publishCodexRelease({
    directory: await fixture(t),
    env,
    run: github.run,
    retryDelay: async () => {},
  });
  assert.equal(github.state.release.draft, false);
  assert.equal(github.state.release.assets.length, 16);
  assert.equal(github.state.uploadAttempts, 18);
});

test("older main and feature results do not become Latest", async (t) => {
  for (const ref of ["refs/heads/main", "refs/heads/feature"]) {
    const github = fakeGithub({ mainSha: "b".repeat(40) });
    await publishCodexRelease({
      directory: await fixture(t),
      env: { ...env, GITHUB_REF: ref },
      run: github.run,
    });
    assert.ok(github.state.calls.at(-1).includes("--latest=false"));
    if (ref.endsWith("feature")) assert.ok(github.state.calls.at(-1).includes("--prerelease=true"));
  }
});

test("foreign target or published incomplete release is never overwritten", async (t) => {
  for (const existing of [
    { draft: true, target_commitish: "wrong", assets: [] },
    { draft: false, target_commitish: sha, assets: [] },
  ]) {
    const github = fakeGithub({ existing });
    await assert.rejects(
      publishCodexRelease({ directory: await fixture(t), env, run: github.run }),
    );
    assert.ok(!github.state.calls.some((args) => ["upload", "edit"].includes(args[1])));
  }
});

test("duplicate installer manifest entries and public-name collisions fail closed", async (t) => {
  for (const kind of ["duplicate", "collision"]) {
    const root = await fixture(t);
    const dir = join(root, "codez-darwin-x64-unsigned");
    const manifest = join(dir, "SHA256SUMS-darwin-x64.txt");
    if (kind === "duplicate") {
      const first = (await readFile(manifest, "utf8")).split("\n")[0];
      await writeFile(manifest, `${first}\n${first}\n`);
    } else {
      // 更名后安装包名不再含空格；构造一个空格规范化后会撞上已存在文件的清单条目，
      // 验证 “Public asset name collision” 仍然 fail closed。
      const lines = (await readFile(manifest, "utf8")).split("\n");
      const original = lines[0].slice(66);
      const spaced = original.replace("-mac-", " -mac-");
      await rm(join(dir, original));
      await writeFile(join(dir, spaced), spaced);
      lines[0] = `${digest(spaced)}  ${spaced}`;
      await writeFile(manifest, `${lines.join("\n")}`);
      await writeFile(join(dir, spaced.replaceAll(" ", ".")), "conflict");
    }
    await assert.rejects(collectReleaseAssets(root));
  }
});

test("API authorization and uploaded-digest errors never publish", async (t) => {
  for (const kind of ["auth", "digest"]) {
    const github = fakeGithub();
    const run = async (args) => {
      if (kind === "auth") throw new Error("HTTP 403: Forbidden");
      const value = await github.run(args);
      if (
        args[0] === "api" &&
        args[1].endsWith("/releases/123") &&
        github.state.release?.assets.length
      ) {
        const data = JSON.parse(value);
        data.assets[0].digest = `sha256:${"0".repeat(64)}`;
        return JSON.stringify(data);
      }
      return value;
    };
    await assert.rejects(publishCodexRelease({ directory: await fixture(t), env, run }));
    assert.ok(!github.state.calls.some((args) => args[1] === "edit"));
  }
});
