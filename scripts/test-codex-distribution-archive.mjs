import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { createCodexTarInvocation, runCodexTar } from "./codex-runtime-archive.mjs";
import { createDeterministicCodexTarGz } from "./codex-runtime-deterministic-archive.mjs";
import { loadCodexNodeManifest, stageCodexRemoteNode } from "./codex-runtime-node.mjs";

test("Windows create/extract/list never pass a drive-qualified archive to GNU tar", () => {
  const archivePath = "C:\\Users\\runner\\archive & spaces\\runtime.tar.gz";
  for (const mode of ["create", "extract", "list"]) {
    const plan = createCodexTarInvocation({
      mode,
      archivePath,
      directory: "C:\\Users\\runner\\archive & spaces\\input",
      entries: ["codex", "bridge.cjs"],
      platform: "win32",
    });
    assert.equal(plan.command, "tar");
    assert.equal(plan.options.cwd, win32.dirname(archivePath));
    assert.equal(plan.options.shell, false);
    assert.equal(plan.args[1], "./runtime.tar.gz");
    assert.equal(plan.args[1].includes(":"), false);
    assert.equal(plan.args[plan.args.indexOf("-C") + 1], "input");
    assert.deepEqual(plan.args.slice(-3), ["--", "codex", "bridge.cjs"]);
  }
});

test("Windows source on another drive remains a directory operand, never an archive operand", () => {
  const plan = createCodexTarInvocation({
    mode: "create",
    archivePath: "C:\\output\\archive.tar.gz",
    directory: "D:\\workspace & spaces\\runtime",
    entries: ["."],
    platform: "win32",
  });
  assert.deepEqual(plan.args, [
    "-czf",
    "./archive.tar.gz",
    "-C",
    "D:/workspace & spaces/runtime",
    "--",
    ".",
  ]);
  assert.throws(() => createCodexTarInvocation({ mode: "unknown", archivePath: "unused" }), /mode/);
});

test("real tar round-trip handles spaces/metacharacters without platform skips", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex archive & spaces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source & input");
  const destination = join(root, "output & destination");
  await mkdir(source);
  await mkdir(destination);
  const archivePath = join(
    root,
    process.platform === "win32" ? "archive & local.tar.gz" : "archive:local.tar.gz",
  );
  await writeFile(join(source, "payload & data.txt"), "archive bytes");
  await writeFile(join(source, "--option-shaped.txt"), "literal filename");
  await runCodexTar({
    mode: "create",
    archivePath,
    directory: source,
    entries: ["payload & data.txt", "--option-shaped.txt"],
  });
  const listing = await runCodexTar({ mode: "list", archivePath });
  assert.deepEqual(listing.stdout.trim().split(/\r?\n/).sort(), [
    "--option-shaped.txt",
    "payload & data.txt",
  ]);
  await runCodexTar({ mode: "extract", archivePath, directory: destination });
  assert.equal(await readFile(join(destination, "payload & data.txt"), "utf8"), "archive bytes");
  assert.equal(
    await readFile(join(destination, "--option-shaped.txt"), "utf8"),
    "literal filename",
  );
});

test("component archive ignores source mtimes and insertion order without losing executable bits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex stable archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(join(source, "bin"), { recursive: true });
  await writeFile(join(source, "z.txt"), "last");
  await writeFile(join(source, "bin", "codex"), "native");
  const first = join(root, "first.tar.gz");
  await createDeterministicCodexTarGz({ archivePath: first, directory: source });
  await utimes(join(source, "z.txt"), new Date("2020-01-01"), new Date("2024-01-01"));
  await utimes(join(source, "bin", "codex"), new Date("2022-01-01"), new Date("2025-01-01"));
  const second = join(root, "second.tar.gz");
  await createDeterministicCodexTarGz({ archivePath: second, directory: source });
  assert.deepEqual(await readFile(first), await readFile(second));
  const extracted = join(root, "extracted");
  await mkdir(extracted);
  await runCodexTar({ mode: "extract", archivePath: second, directory: extracted });
  assert.equal(await readFile(join(extracted, "bin", "codex"), "utf8"), "native");
});

test("verified local Node archive extracts only pinned member; tar failure preserves installed binary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex Node & spaces-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = { os: "linux", arch: "x64", key: "linux-x64" };
  const memberRoot = "node-v24.14.0-linux-x64";
  const directory = join(root, "installed");
  await mkdir(join(root, memberRoot, "bin"), { recursive: true });
  await writeFile(join(root, memberRoot, "bin/node"), "verified Node fixture");
  await writeFile(join(root, memberRoot, "unselected.txt"), "must not extract");
  const archivePath = join(root, "node.tar.gz");
  await runCodexTar({ mode: "create", archivePath, directory: root, entries: [memberRoot] });
  const bytes = await readFile(archivePath);
  const manifest = await loadCodexNodeManifest();
  manifest.assets[target.key] = createHash("sha256").update(bytes).digest("hex");
  await stageCodexRemoteNode({
    directory,
    target,
    manifest,
    fetchImpl: async () => new Response(bytes),
  });
  assert.equal(await readFile(join(directory, "node"), "utf8"), "verified Node fixture");
  assert.equal((await readdir(directory)).includes("unselected.txt"), false);
  const corrupt = Buffer.from("checksum matches but not an archive");
  manifest.assets[target.key] = createHash("sha256").update(corrupt).digest("hex");
  await assert.rejects(
    stageCodexRemoteNode({
      directory,
      target,
      manifest,
      fetchImpl: async () => new Response(corrupt),
    }),
  );
  assert.equal(await readFile(join(directory, "node"), "utf8"), "verified Node fixture");
  assert.equal(
    (await readdir(directory)).some((name) => name.startsWith(".node-")),
    false,
  );
});

test("remote Node retries transient downloads but fails closed on HTTP 404 and checksum mismatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex Node retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = { os: "linux", arch: "x64", key: "linux-x64" };
  const memberRoot = "node-v24.14.0-linux-x64";
  const directory = join(root, "installed");
  await mkdir(join(root, memberRoot, "bin"), { recursive: true });
  await writeFile(join(root, memberRoot, "bin/node"), "verified Node fixture");
  const archivePath = join(root, "node.tar.gz");
  await runCodexTar({ mode: "create", archivePath, directory: root, entries: [memberRoot] });
  const bytes = await readFile(archivePath);
  const manifest = await loadCodexNodeManifest();
  manifest.assets[target.key] = createHash("sha256").update(bytes).digest("hex");
  const retryDelay = async () => {};
  let attempts = 0;
  await stageCodexRemoteNode({
    directory,
    target,
    manifest,
    retryDelay,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new DOMException("request timed out", "TimeoutError");
      if (attempts === 2) return new Response(null, { status: 503 });
      if (attempts === 3)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 8));
              queueMicrotask(() =>
                controller.error(Object.assign(new Error("socket reset"), { code: "ECONNRESET" })),
              );
            },
          }),
        );
      return new Response(bytes);
    },
  });
  assert.equal(attempts, 4);
  assert.equal(await readFile(join(directory, "node"), "utf8"), "verified Node fixture");
  assert.equal(
    (await readdir(directory)).some((name) => name.startsWith(".node-")),
    false,
  );

  let rateLimitAttempts = 0;
  await stageCodexRemoteNode({
    directory,
    target,
    manifest,
    retryDelay,
    fetchImpl: async () => {
      rateLimitAttempts += 1;
      return rateLimitAttempts === 1 ? new Response(null, { status: 429 }) : new Response(bytes);
    },
  });
  assert.equal(rateLimitAttempts, 2);

  for (const [label, response] of [
    ["HTTP 404", () => new Response(null, { status: 404 })],
    ["checksum mismatch", () => new Response(Buffer.from("tampered archive"))],
    [
      "cancelled",
      () => {
        throw new DOMException("cancelled", "AbortError");
      },
    ],
  ]) {
    let failedAttempts = 0;
    await assert.rejects(
      stageCodexRemoteNode({
        directory,
        target,
        manifest,
        retryDelay,
        fetchImpl: async () => {
          failedAttempts += 1;
          return response();
        },
      }),
      label === "HTTP 404" ? /HTTP 404/ : label === "cancelled" ? /cancelled/ : /checksum mismatch/,
    );
    assert.equal(failedAttempts, 1, label);
    assert.equal(await readFile(join(directory, "node"), "utf8"), "verified Node fixture");
    assert.equal(
      (await readdir(directory)).some((name) => name.startsWith(".node-")),
      false,
    );
  }

  let exhaustedAttempts = 0;
  await assert.rejects(
    stageCodexRemoteNode({
      directory,
      target,
      manifest,
      retryDelay,
      fetchImpl: async () => {
        exhaustedAttempts += 1;
        throw new DOMException("request timed out", "TimeoutError");
      },
    }),
    /request timed out/,
  );
  assert.equal(exhaustedAttempts, 4);
  assert.equal(await readFile(join(directory, "node"), "utf8"), "verified Node fixture");
  assert.equal(
    (await readdir(directory)).some((name) => name.startsWith(".node-")),
    false,
  );
});
