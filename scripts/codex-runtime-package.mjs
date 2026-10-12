import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { runCodexTar } from "./codex-runtime-archive.mjs";

const PACKAGE_ROOTS = new Set(["bin", "codex-package.json", "codex-path", "codex-resources"]);

export async function sha256File(path) {
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error(`Expected regular file: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function hashPackageFiles(directory, files) {
  const hashes = {};
  for (const name of files) hashes[name] = await sha256File(join(directory, name));
  return hashes;
}

export function assertPackageFileHashes(actual, expected) {
  if (
    !expected ||
    typeof expected !== "object" ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  )
    throw new Error("Codex package file checksum mismatch");
}

export async function verifyCodexPackage({ directory, target, asset }) {
  const inspection = await inspectCodexPackage(directory, target, ["package-integrity.json"]);
  const integrity = JSON.parse(await readFile(join(directory, "package-integrity.json"), "utf8"));
  if (integrity.packageSha256 !== asset.sha256)
    throw new Error("Codex package archive checksum mismatch");
  assertPackageFileHashes(await hashPackageFiles(directory, inspection.files), integrity.files);
  return inspection.binary;
}

export function codexPackageTargetTriple(target) {
  const arch = target.arch === "arm64" ? "aarch64" : "x86_64";
  const platform = {
    darwin: "apple-darwin",
    linux: "unknown-linux-musl",
    win32: "pc-windows-msvc",
  }[target.os];
  if (!platform || !["x64", "arm64"].includes(target.arch))
    throw new Error("Unsupported Codex package target");
  return `${arch}-${platform}`;
}

export async function validateCodexPackageArchive(archivePath) {
  const [listed, verbose] = await Promise.all([
    runCodexTar({ mode: "list", archivePath }),
    runCodexTar({ mode: "listVerbose", archivePath }),
  ]);
  const entries = listed.stdout.trim().split(/\r?\n/u);
  const types = verbose.stdout.trim().split(/\r?\n/u);
  if (entries.length === 0 || entries.length > 256 || types.length !== entries.length)
    throw new Error("Invalid Codex package archive entry count");
  const seen = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const raw = entries[index];
    const name = raw.replace(/^\.\//u, "").replace(/\/$/u, "");
    const type = types[index][0];
    // 修复原因：已验证 digest 的压缩包仍不能让 tar 通过绝对路径、上跳或链接写出暂存目录。
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((segment) => segment === "." || segment === ".." || !segment) ||
      Array.from(name).some((character) => character.charCodeAt(0) < 32 || character === ":") ||
      !PACKAGE_ROOTS.has(name.split("/")[0]) ||
      seen.has(name) ||
      !["-", "d"].includes(type)
    )
      throw new Error(`Unsafe Codex package archive entry: ${name}`);
    seen.add(name);
  }
}

async function listRegularFiles(directory, prefix, result) {
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await listRegularFiles(directory, name, result);
    } else if (entry.isFile()) {
      result.push(name);
    } else {
      throw new Error(`Unsafe Codex package entry: ${name}`);
    }
  }
}

export async function inspectCodexPackage(directory, target, extraFiles = []) {
  const packagePath = join(directory, "codex-package.json");
  if (!(await lstat(packagePath)).isFile()) throw new Error("Unsafe Codex package manifest link");
  const metadata = JSON.parse(await readFile(packagePath, "utf8"));
  const executable = target.os === "win32" ? ".exe" : "";
  const binary = `bin/codex${executable}`;
  const host = `bin/codex-code-mode-host${executable}`;
  const search = `codex-path/rg${executable}`;
  if (
    metadata.layoutVersion !== 1 ||
    metadata.target !== codexPackageTargetTriple(target) ||
    metadata.variant !== "codex" ||
    metadata.entrypoint !== binary ||
    metadata.resourcesDir !== "codex-resources" ||
    metadata.pathDir !== "codex-path" ||
    typeof metadata.version !== "string" ||
    !metadata.version.trim()
  )
    throw new Error("Invalid Codex package manifest or target");

  const roots = await readdir(directory);
  const allowed = new Set([...PACKAGE_ROOTS, ...extraFiles]);
  if (roots.some((name) => !allowed.has(name)))
    throw new Error("Unexpected Codex package root entry");
  for (const name of ["bin", "codex-path", "codex-resources"]) {
    if (!(await lstat(join(directory, name))).isDirectory())
      throw new Error(`Invalid Codex package directory: ${name}`);
  }
  const files = [];
  for (const name of ["bin", "codex-path", "codex-resources"])
    await listRegularFiles(directory, name, files);
  files.push("codex-package.json");
  for (const name of [binary, host, search]) {
    if (!files.includes(name))
      throw new Error(`Missing Codex package tool host or binary: ${name}`);
    // Windows 宿主没有可靠的 POSIX execute-bit 文件系统语义；跨目标分发回归仍验证
    // 内容和布局，真实可执行模式由对应 Linux/macOS CI 目标在本地解包后强制检查。
    if (
      target.os !== "win32" &&
      target.os === process.platform &&
      !((await lstat(join(directory, name))).mode & 0o111)
    )
      throw new Error(`Codex package executable mode missing: ${name}`);
  }
  return { binary: join(directory, ...posix.normalize(binary).split("/")), files: files.sort() };
}
