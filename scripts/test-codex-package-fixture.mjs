import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCodexTar } from "./codex-runtime-archive.mjs";

export function packageTargetTriple(target) {
  const arch = target.arch === "arm64" ? "aarch64" : "x86_64";
  const suffix = {
    darwin: "apple-darwin",
    linux: "unknown-linux-musl",
    win32: "pc-windows-msvc",
  }[target.os];
  return `${arch}-${suffix}`;
}

export async function createMockCodexPackage(
  root,
  target,
  { omitToolHost = false, linkToolHost = false, emptyResources = false } = {},
) {
  const source = join(root, `package-source-${randomUUID()}`);
  const executable = target.os === "win32" ? ".exe" : "";
  await mkdir(join(source, "bin"), { recursive: true });
  await mkdir(join(source, "codex-path"), { recursive: true });
  await mkdir(join(source, "codex-resources"), { recursive: true });
  const binary = join(source, "bin", `codex${executable}`);
  await writeFile(binary, "mock native executable\n");
  await chmod(binary, 0o755);
  if (!omitToolHost) {
    const host = join(source, "bin", `codex-code-mode-host${executable}`);
    if (linkToolHost) {
      await symlink("../../outside", host);
    } else {
      await writeFile(host, "mock native tool host\n");
      await chmod(host, 0o755);
    }
  }
  const ripgrep = join(source, "codex-path", `rg${executable}`);
  await writeFile(ripgrep, "mock native search\n");
  await chmod(ripgrep, 0o755);
  if (!emptyResources) {
    await writeFile(join(source, "codex-resources", "resource.txt"), "mock resource\n");
  }
  await writeFile(
    join(source, "codex-package.json"),
    JSON.stringify({
      layoutVersion: 1,
      version: "0.160.1",
      target: packageTargetTriple(target),
      variant: "codex",
      entrypoint: `bin/codex${executable}`,
      resourcesDir: "codex-resources",
      pathDir: "codex-path",
    }),
  );
  const archivePath = join(root, `mock-codex-${randomUUID()}.tar.gz`);
  await runCodexTar({
    mode: "create",
    archivePath,
    directory: source,
    entries: ["bin", "codex-package.json", "codex-path", "codex-resources"],
  });
  const bytes = await readFile(archivePath);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}
