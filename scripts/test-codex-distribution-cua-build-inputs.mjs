import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(new URL("../packages/desktop/package.json", import.meta.url));
const workflow = require("yaml").parse(
  await readFile(new URL("../.github/workflows/codex-desktop.yml", import.meta.url), "utf8"),
);
const { steps } = workflow.jobs.build;
const packagingIndex = steps.findIndex((step) => step.run?.includes("exec electron-builder"));

// 回归依据：旧流水线六平台编译通过，但 macOS/Linux 在 afterPack 缺少必填输入。
// 锁住输入的生产步骤与先后顺序，不允许靠跳过 Helper 或关闭校验修复出包。
test("macOS prepares all verified Helper Node inputs before packaging", () => {
  const index = steps.findIndex((step) => step.name === "Prepare macOS Computer Use Helper Node");
  assert.ok(index >= 0 && index < packagingIndex);
  assert.equal(steps[index].if, "matrix.os == 'darwin'");
  for (const key of [
    "CODEZ_CUA_MAC_NODE_EXECUTABLE",
    "CODEZ_CUA_MAC_NODE_VERSION",
    "CODEZ_CUA_MAC_NODE_SHA256",
  ]) {
    assert.ok(steps[index].run.includes(key), `Missing macOS build input: ${key}`);
  }
});

test("macOS preparation exports the real Node executable, version and byte hash", async (t) => {
  const step = steps.find(
    (candidate) => candidate.name === "Prepare macOS Computer Use Helper Node",
  );
  assert.ok(step, "Missing macOS Helper preparation");
  const directory = await mkdtemp(join(tmpdir(), "codez-cua-node-inputs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, "github-env");
  await execFileAsync("bash", ["-eu", "-o", "pipefail", "-c", step.run], {
    env: { ...process.env, GITHUB_ENV: envFile },
  });
  const values = Object.fromEntries(
    (await readFile(envFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  const executable = await realpath(process.execPath);
  assert.equal(values.CODEZ_CUA_MAC_NODE_EXECUTABLE, executable);
  assert.equal(values.CODEZ_CUA_MAC_NODE_VERSION, process.versions.node);
  assert.equal(
    values.CODEZ_CUA_MAC_NODE_SHA256,
    createHash("sha256")
      .update(await readFile(executable))
      .digest("hex"),
  );
});

test("Linux builds a pinned native xa11y package before installer packaging", () => {
  const checkoutIndex = steps.findIndex(
    (step) => step.with?.repository === "xa11y/xa11y" && step.if === "matrix.os == 'linux'",
  );
  assert.ok(checkoutIndex >= 0);
  const checkout = steps[checkoutIndex];
  assert.equal(checkout.if, "matrix.os == 'linux'");
  assert.equal(checkout.with.ref, "a3badccf5761615ea3412ee55c19ac3764e27913");
  assert.equal(checkout.with["persist-credentials"], false);

  const index = steps.findIndex(
    (step) => step.name === "Build Linux Computer Use addon on glibc 2.28",
  );
  assert.ok(index > checkoutIndex && index < packagingIndex);
  assert.equal(steps[index].if, "matrix.os == 'linux'");
  assert.match(steps[index].run, /scripts\/build-linux-cua-xa11y\.sh/u);
  assert.ok(steps[index].run.includes(checkout.with.path));
  assert.match(steps[index].run, /CODEZ_CUA_LINUX_XA11Y_NATIVE_ROOT=/u);
  assert.match(steps[index].run, /GITHUB_ENV/u);
});

test("Windows rebuilds the HWND-scoped addon and tests it before installer packaging", async () => {
  const checkoutIndex = steps.findIndex(
    (step) => step.with?.repository === "xa11y/xa11y" && step.if === "matrix.os == 'win32'",
  );
  assert.ok(checkoutIndex >= 0, "Missing pinned Windows addon source");
  const checkout = steps[checkoutIndex];
  assert.equal(checkout.with.ref, "a3badccf5761615ea3412ee55c19ac3764e27913");
  assert.equal(checkout.with["persist-credentials"], false);
  const index = steps.findIndex((step) => step.name === "Build patched Windows Computer Use addon");
  assert.ok(index > checkoutIndex && index < packagingIndex);
  assert.equal(steps[index].if, "matrix.os == 'win32'");
  assert.match(steps[index].run, /scripts\/build-windows-cua-xa11y\.sh/u);
  assert.ok(steps[index].run.includes(checkout.with.path));
  assert.match(steps[index].run, /CODEZ_CUA_WINDOWS_XA11Y_NATIVE_ROOT=/u);
  assert.match(steps[index].run, /GITHUB_ENV/u);

  const script = await readFile(new URL("./build-windows-cua-xa11y.sh", import.meta.url), "utf8");
  assert.match(script, /x86_64-pc-windows-msvc/u);
  assert.match(script, /aarch64-pc-windows-msvc/u);
  assert.match(script, /rustup toolchain install 1\.95\.0/u);
  assert.match(script, /git .*apply --check/u);
  assert.match(script, /git .*archive --format=tar HEAD \| tar -x/u);
  assert.match(script, /cua-xa11y-0\.15\.0-windows\.patch/u);
  assert.match(script, /cua-xa11y-0\.15\.0-lock\.patch/u);
  assert.match(script, /cargo \+1\.95\.0 test --locked[\s\S]*-p xa11y-windows --lib codez_/u);
  assert.match(script, /cargo \+1\.95\.0 build --release --locked/u);
  assert.match(script, /xa11y_js\.dll/u);
  assert.match(script, /source\/xa11y-js\/Cargo\.toml/u);
  for (const name of ["cua-xa11y-0.15.0-windows.patch", "cua-xa11y-0.15.0-lock.patch"]) {
    assert.ok((await readFile(new URL(`./${name}`, import.meta.url), "utf8")).length > 0);
  }
  const patch = await readFile(
    new URL("./cua-xa11y-0.15.0-windows.patch", import.meta.url),
    "utf8",
  );
  assert.equal((patch.match(/^\+\s+fn codez_/gmu) ?? []).length, 3);
  assert.match(patch, /^\+.*EnumWindows/gmu);
  assert.match(patch, /^-.*root\.FindFirstBuildCache/gmu);
  assert.match(patch, /^-.*root\.FindAllBuildCache/gmu);

  const builder = await readFile(
    new URL("../packages/desktop/electron-builder.config.js", import.meta.url),
    "utf8",
  );
  assert.match(builder, /resolveWindowsCuaNativePackageRoots\(\{[\s\S]*?actualCuaTarget/u);
  const checks = workflow.jobs["remote-assets"].steps.map((step) => step.run ?? "").join("\n");
  assert.ok(checks.includes("packages/desktop/scripts/windows-cua-native-package.test.mjs"));
});

test("Linux addon build uses native manylinux_2_28 and the upstream locked Cargo closure", async () => {
  const script = await readFile(new URL("./build-linux-cua-xa11y.sh", import.meta.url), "utf8");
  assert.match(
    script,
    /x64\)[\s\S]*native_machine=x86_64[\s\S]*rust_target=x86_64-unknown-linux-gnu/u,
  );
  assert.match(
    script,
    /arm64\)[\s\S]*native_machine=aarch64[\s\S]*rust_target=aarch64-unknown-linux-gnu/u,
  );
  assert.match(script, /quay\.io\/pypa\/manylinux_2_28_\$native_machine/u);
  assert.match(script, /source_root:\/source:ro/u);
  assert.match(script, /--default-toolchain 1\.95\.0/u);
  assert.match(script, /cargo build --release --locked/u);
  assert.match(script, /\/build\/source\/xa11y-js\/Cargo\.toml/u);
  assert.match(script, /patch --batch --fuzz=0/u);
  assert.match(script, /cua-xa11y-0\.15\.0-lock\.patch:\/cua-lock\.patch:ro/u);
  assert.match(script, /libxa11y_js\.so/u);
  assert.match(script, /dnf install -y libxkbcommon-devel/u);

  const commands = workflow.jobs["remote-assets"].steps.map((step) => step.run ?? "").join("\n");
  assert.match(commands, /pnpm --filter @codez\/codez-cua test/u);
  for (const name of [
    "linux-cua-native-package",
    "windows-cua-runtime-assets",
    "macos-cua-helper-app",
  ]) {
    assert.ok(commands.includes(`packages/desktop/scripts/${name}.test.mjs`));
  }
});

for (const [name, eol] of [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
]) {
  test(`the ${name} xa11y lock correction changes only path crate versions and existing dependency edges`, async () => {
    // 回归依据：Windows 检出补丁时会转换为 CRLF，不能让行尾 CR 参与内容比较。
    const patch = (
      await readFile(new URL("./cua-xa11y-0.15.0-lock.patch", import.meta.url), "utf8")
    ).replace(/\r?\n/gu, eol);
    const additions = patch
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    const deletions = patch
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("-") && !line.startsWith("---"));
    assert.equal(additions.filter((line) => line === '+version = "0.15.0"').length, 6);
    assert.equal(deletions.filter((line) => line === '-version = "0.14.0"').length, 6);
    assert.deepEqual(
      additions.filter((line) => line !== '+version = "0.15.0"'),
      ['+ "memoffset",', '+ "nix",'],
    );
    assert.equal(deletions.length, 6);
  });
}
