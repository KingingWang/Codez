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
  x64)
    native_machine=x86_64
    rust_target=x86_64-unknown-linux-gnu
    ;;
  arm64)
    native_machine=aarch64
    rust_target=aarch64-unknown-linux-gnu
    ;;
  *)
    printf 'Unsupported Linux CUA architecture: %s\n' "$target_arch" >&2
    exit 1
    ;;
esac

if [[ $(uname -m) != "$native_machine" ]]; then
  printf 'Linux CUA addon requires the matching native runner: %s\n' "$native_machine" >&2
  exit 1
fi

# 修复原因：npm 的 0.15.0 addon 要求 GLIBC_2.39；宿主 Ubuntu 重编译仍会继承
# 过高基线。固定源码只读挂载，在对应架构 manylinux_2_28 内链接，再交给既有 stager 校验。
docker run --rm \
  --volume "$source_root:/source:ro" \
  --volume "$output_root:/build" \
  --volume "$repo_root/scripts/cua-xa11y-0.15.0-lock.patch:/cua-lock.patch:ro" \
  --env CARGO_HOME=/build/cargo \
  --env RUSTUP_HOME=/build/rustup \
  --env CARGO_TARGET_DIR=/build/target \
  --env "CUA_RUST_TARGET=$rust_target" \
  --env "CUA_TARGET_ARCH=$target_arch" \
  "quay.io/pypa/manylinux_2_28_$native_machine" \
  bash -euo pipefail -c '
    dnf install -y libxkbcommon-devel
    curl --proto "=https" --tlsv1.2 --retry 3 -fsS https://sh.rustup.rs -o /build/rustup-init.sh
    sh /build/rustup-init.sh -y --profile minimal --default-toolchain 1.95.0 --no-modify-path
    export PATH="/build/cargo/bin:$PATH"
    mkdir -p /build/source
    cp -a /source/. /build/source/
    # 上游 JS lock 仍是 0.14.0；仅修正路径 crate 版本与漏记的现有依赖边，不浮动更新第三方库。
    patch --batch --fuzz=0 --directory=/build/source -p1 < /cua-lock.patch
    /build/cargo/bin/cargo build --release --locked \
      --manifest-path /build/source/xa11y-js/Cargo.toml --target "$CUA_RUST_TARGET"
    install -m 644 \
      "/build/target/$CUA_RUST_TARGET/release/libxa11y_js.so" \
      "/build/package/xa11y.linux-$CUA_TARGET_ARCH-gnu.node"
  '

# 沿用 frozen-lockfile 安装的目标包元数据；只替换同版本源码生成的 addon 字节。
node --input-type=module - "$repo_root" "$output_root" "$target_arch" "$source_root" <<'NODE'
import { copyFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const [repoRoot, outputRoot, arch, sourceRoot] = process.argv.slice(2);
const require = createRequire(resolve(repoRoot, "packages/codez-cua/package.json"));
const metadata = require.resolve(`@crowecawcaw/xa11y-linux-${arch}-gnu/package.json`);
const source = JSON.parse(await readFile(resolve(sourceRoot, "xa11y-js/package.json"), "utf8"));
const native = JSON.parse(await readFile(metadata, "utf8"));
if (source.version !== native.version) throw new Error("xa11y source/native package version mismatch");
await copyFile(metadata, resolve(outputRoot, "package/package.json"));
NODE
