#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  printf 'Usage: %s <pinned-xa11y-source> <build-output> <x64|arm64>\n' "$0" >&2
  exit 1
fi

source_root=$(realpath "$1")
mkdir -p "$2/package"
output_root=$(realpath "$2")
target_arch=$3
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

case "$target_arch" in
  x64) rust_target=x86_64-pc-windows-msvc ;;
  arm64) rust_target=aarch64-pc-windows-msvc ;;
  *)
    printf 'Unsupported Windows CUA architecture: %s\n' "$target_arch" >&2
    exit 1
    ;;
esac

node -e 'if (process.platform !== "win32" || process.arch !== process.argv[1]) throw new Error("Windows CUA addon requires a matching native runner")' "$target_arch"
if [[ $(git -C "$source_root" rev-parse HEAD) != a3badccf5761615ea3412ee55c19ac3764e27913 ]]; then
  printf 'Windows CUA addon source revision does not match xa11y 0.15.0\n' >&2
  exit 1
fi

mkdir -p "$output_root/source"
# 从固定 commit 导出规范行尾，避免 Windows autocrlf 让正确补丁在工作副本上失配。
git -C "$source_root" archive --format=tar HEAD | tar -x -C "$output_root/source"
# 根因：App.byPid / App.windows 仍在 desktop UIA root 搜索，受无关 provider 超时影响。
# 只在固定源码上应用 HWND/PID 修补；补丁不匹配即终止，不能发布未修补的 npm addon。
git -C "$output_root/source" apply --check "$repo_root/scripts/cua-xa11y-0.15.0-windows.patch"
git -C "$output_root/source" apply "$repo_root/scripts/cua-xa11y-0.15.0-windows.patch"
git -C "$output_root/source" apply --check "$repo_root/scripts/cua-xa11y-0.15.0-lock.patch"
git -C "$output_root/source" apply "$repo_root/scripts/cua-xa11y-0.15.0-lock.patch"

rustup toolchain install 1.95.0 --profile minimal --no-self-update
rustup target add "$rust_target" --toolchain 1.95.0
# Git Bash 路径不能原样留给原生 cargo 的环境变量；传入明确的 Windows 绝对路径。
export CARGO_TARGET_DIR="$(cygpath -w "$output_root/target")"
cargo +1.95.0 test --locked \
  --manifest-path "$output_root/source/Cargo.toml" --target "$rust_target" \
  -p xa11y-windows --lib codez_
cargo +1.95.0 build --release --locked \
  --manifest-path "$output_root/source/xa11y-js/Cargo.toml" --target "$rust_target"
cp "$output_root/target/$rust_target/release/xa11y_js.dll" \
  "$output_root/package/xa11y.win32-$target_arch-msvc.node"

# 复用 frozen-lockfile 的包身份和版本；后续 stager 仍负责文件集及完整性校验。
node --input-type=module - "$repo_root" "$output_root" "$target_arch" "$source_root" <<'NODE'
import { copyFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const [repoRoot, outputRoot, arch, sourceRoot] = process.argv.slice(2);
const require = createRequire(resolve(repoRoot, "packages/codez-cua/package.json"));
const metadata = require.resolve(`@crowecawcaw/xa11y-win32-${arch}-msvc/package.json`);
const source = JSON.parse(await readFile(resolve(sourceRoot, "xa11y-js/package.json"), "utf8"));
const native = JSON.parse(await readFile(metadata, "utf8"));
if (source.version !== native.version) throw new Error("xa11y source/native package version mismatch");
await copyFile(metadata, resolve(outputRoot, "package/package.json"));
NODE
