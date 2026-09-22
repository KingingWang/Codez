import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  downloadVerifiedBinary,
  loadCodexManifest,
  resolveCodexTarget,
  selectCodexAsset,
} from "./codex-runtime.mjs";

const bytes = Buffer.from("mock native executable\n");
const retryDelay = async () => {};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = structuredClone(await loadCodexManifest());
  manifest.assets["linux-x64"].sha256 = createHash("sha256").update(bytes).digest("hex");
  manifest.assets["linux-x64"].size = bytes.length;
  const target = resolveCodexTarget({ ZCODE_TARGET_OS: "linux", ZCODE_TARGET_ARCH: "x64" });
  return { root, asset: selectCodexAsset(manifest, target) };
}

test("transient download failures retry while integrity and 4xx fail closed", async (t) => {
  const { root, asset } = await fixture(t);
  let resets = 0;
  const recovered = join(root, "recovered");
  await downloadVerifiedBinary(
    recovered,
    asset,
    async () => {
      resets += 1;
      // 复现 runner 上的 read ECONNRESET：前两次连接被重置，第三次才拿到完整产物。
      if (resets < 3) throw Object.assign(new Error("fetch failed"), { cause: "ECONNRESET" });
      return new Response(bytes);
    },
    { retryDelay },
  );
  assert.equal(resets, 3);
  assert.equal(await readFile(recovered, "utf8"), bytes.toString());

  let truncated = 0;
  await assert.rejects(
    downloadVerifiedBinary(
      join(root, "short"),
      { ...asset, size: bytes.length + 1 },
      async () => {
        truncated += 1;
        return new Response(bytes);
      },
      { retryDelay },
    ),
    /size mismatch/,
  );
  assert.equal(truncated, 1);

  let forbidden = 0;
  await assert.rejects(
    downloadVerifiedBinary(
      join(root, "missing"),
      asset,
      async () => {
        forbidden += 1;
        return new Response(null, { status: 404 });
      },
      { retryDelay },
    ),
    /HTTP 404/,
  );
  assert.equal(forbidden, 1);
});

test("partial download removes the stale file before retrying", async (t) => {
  const { root, asset } = await fixture(t);
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    if (hits === 1) {
      response.writeHead(200, { "Content-Length": String(bytes.length) });
      response.write(bytes.subarray(0, 4));
      // CDN 中途断连会在磁盘留下不完整文件；重试必须能覆盖它。
      response.destroy();
      return;
    }
    response.end(bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  );
  const path = join(root, "resumed");
  await downloadVerifiedBinary(
    path,
    asset,
    (_url, init) => fetch(`http://127.0.0.1:${server.address().port}/fixture`, init),
    { retryDelay },
  );
  assert.equal(hits, 2);
  assert.equal(await readFile(path, "utf8"), bytes.toString());
});
