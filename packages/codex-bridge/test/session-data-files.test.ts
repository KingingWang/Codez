// specs/codex-session-data-purge.md：磁盘事实层的边界测试。
// 锁住三件事：rollout 计量只认文件名语法证明归属的文件、失败重试索引不能写出目录、
// 附件清理只 unlink 已证明归属的对象（绝不递归删目录、绝不动 staging）。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearPendingTree,
  isThreadId,
  listExistingPaths,
  measureExistingFiles,
  readPendingTree,
  rolloutThreadIdOf,
  scanRolloutFiles,
  scopedRolloutPath,
  writePendingTree,
} from "../src/session-data-files.js";
import {
  listBridgeAttachmentScopes,
  listOwnedAttachmentObjects,
  removeAttachmentObjects,
} from "../src/session-data-attachments.js";

const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const SCOPE = "a".repeat(64);

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeRollout(
  codexHome: string,
  threadId: string,
  options: {
    archived?: boolean;
    zst?: boolean;
    bytes?: number;
    suffix?: string;
    depth?: string[];
  } = {},
): Promise<string> {
  const segments = options.depth ?? ["2026", "11", "01"];
  const dir = join(codexHome, options.archived ? "archived_sessions" : "sessions", ...segments);
  await mkdir(dir, { recursive: true });
  const name = `rollout-2026-11-01T10-00-00-${threadId}${options.suffix ?? ""}.jsonl${
    options.zst ? ".zst" : ""
  }`;
  const path = join(dir, name);
  await writeFile(path, Buffer.alloc(options.bytes ?? 10));
  return path;
}

async function writeAttachment(
  bridgeHome: string,
  sessionId: string,
  options: { bytes?: number; scope?: string; corrupt?: boolean; id?: string } = {},
): Promise<{ id: string; dataPath: string; manifestPath: string }> {
  const scope = options.scope ?? SCOPE;
  const objects = join(bridgeHome, scope, "attachments", "objects");
  await mkdir(objects, { recursive: true });
  const id = options.id ?? "44444444-4444-4444-8444-444444444444";
  const dataPath = join(objects, `${id}.data`);
  const manifestPath = join(objects, `${id}.json`);
  await writeFile(dataPath, Buffer.alloc(options.bytes ?? 7));
  await writeFile(
    manifestPath,
    options.corrupt
      ? "{ not json"
      : JSON.stringify({
          version: 1,
          workspace: scope,
          id,
          upload: {
            connectionId: "test",
            uploadId: id,
            sessionId,
            fileName: "image.png",
            mime: "image/png",
            totalBytes: options.bytes ?? 7,
            totalChunks: 1,
            checksum: "sha256:test",
          },
        }),
  );
  return { id, dataPath, manifestPath };
}

test("rollout 扫描只收文件名语法证明归属的文件，含 zst 与归档目录", async (t) => {
  const codexHome = await temporaryDirectory("codez-session-data-files-");
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const plain = await writeRollout(codexHome, ROOT, { bytes: 11 });
  const compressed = await writeRollout(codexHome, ROOT, { zst: true, bytes: 5 });
  const archived = await writeRollout(codexHome, ROOT, { archived: true, bytes: 3 });
  // revert 会为同一线程产生带 _<rolloutId> 后缀的额外 rollout，同样归属该线程。
  const reverted = await writeRollout(codexHome, ROOT, { suffix: `_${CHILD}`, bytes: 2 });
  await writeRollout(codexHome, CHILD, { bytes: 17 });
  const unrelated = await writeRollout(codexHome, OTHER, { bytes: 23 });

  const found = await scanRolloutFiles(codexHome, new Set([ROOT.toLowerCase()]));
  assert.deepEqual(
    [...(found.get(ROOT) ?? [])].sort(),
    [archived, compressed, plain, reverted].sort(),
  );
  assert.equal(found.has(CHILD), false);
  assert.equal(found.has(OTHER), false);
  assert.equal((await measureExistingFiles([unrelated])).size, 1);

  const sizes = await measureExistingFiles([...(found.get(ROOT) ?? [])]);
  assert.equal(
    [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0),
    11 + 5 + 3 + 2,
  );
});

test("rollout 扫描不跟随符号链接，超预算 fail-closed", async (t) => {
  const codexHome = await temporaryDirectory("codez-session-data-files-");
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const outside = await temporaryDirectory("codez-session-data-outside-");
  t.after(() => rm(outside, { recursive: true, force: true }));
  const real = await writeRollout(outside, ROOT, { bytes: 9, depth: [] });
  const sessions = join(codexHome, "sessions");
  await mkdir(sessions, { recursive: true });
  await symlink(join(outside, "sessions"), join(sessions, "2026"), "dir");
  await symlink(real, join(sessions, `rollout-2026-11-01T10-00-00-${ROOT}.jsonl`));

  const found = await scanRolloutFiles(codexHome, new Set([ROOT]));
  assert.deepEqual([...found.values()].flat(), [], "符号链接既不作为文件计量也不下降");

  await writeRollout(codexHome, ROOT, { bytes: 1 });
  await assert.rejects(
    scanRolloutFiles(codexHome, new Set([ROOT]), { maxEntries: 1 }),
    /exceeded budget/,
  );
});

test("文件名语法与 id 校验拒绝非法输入", () => {
  assert.equal(rolloutThreadIdOf(`rollout-2026-11-01T10-00-00-${ROOT}.jsonl`), ROOT);
  assert.equal(rolloutThreadIdOf(`rollout-2026-11-01T10-00-00-${ROOT}.jsonl.zst`), ROOT);
  assert.equal(rolloutThreadIdOf(`rollout-2026-11-01T10-00-00-${ROOT}_${CHILD}.jsonl`), ROOT);
  assert.equal(rolloutThreadIdOf(`rollout-not-a-thread.jsonl`), undefined);
  assert.equal(rolloutThreadIdOf(`${ROOT}.jsonl`), undefined);
  assert.equal(isThreadId(ROOT), true);
  assert.equal(isThreadId("../../etc/passwd"), false);
});

test("删后复查只报告仍然存在的文件", async (t) => {
  const codexHome = await temporaryDirectory("codez-session-data-files-");
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const present = await writeRollout(codexHome, ROOT, { bytes: 4 });
  const missing = join(codexHome, "sessions", "2026", "11", "01", "gone.jsonl");
  assert.deepEqual(await listExistingPaths([present, missing]), [present]);
  await rm(present);
  assert.deepEqual(await listExistingPaths([present, missing]), []);
  assert.equal((await measureExistingFiles([present, missing])).size, 0);
});

test("重试索引原子往返，拒绝非 UUID 根与损坏内容", async (t) => {
  const pendingRoot = join(await temporaryDirectory("codez-session-data-pending-"), "pending");
  t.after(() => rm(pendingRoot, { recursive: true, force: true }));
  assert.equal(await readPendingTree(pendingRoot, ROOT), undefined);

  await writePendingTree(pendingRoot, { rootId: ROOT, threadIds: [ROOT, CHILD], updatedAt: 1 });
  const read = await readPendingTree(pendingRoot, ROOT);
  assert.deepEqual(read?.threadIds, [ROOT, CHILD]);

  await clearPendingTree(pendingRoot, ROOT);
  await clearPendingTree(pendingRoot, ROOT);
  assert.equal(await readPendingTree(pendingRoot, ROOT), undefined);

  await assert.rejects(
    writePendingTree(pendingRoot, { rootId: "../escape", threadIds: [ROOT], updatedAt: 1 }),
    /invalid thread id/,
  );
  await assert.rejects(readPendingTree(pendingRoot, "../../etc"), /invalid thread id/);

  await writePendingTree(pendingRoot, { rootId: ROOT, threadIds: [ROOT], updatedAt: 1 });
  await writeFile(join(pendingRoot, `${ROOT.toLowerCase()}.json`), "{ half");
  await assert.rejects(readPendingTree(pendingRoot, ROOT), /retry index is corrupt/);
});

test("附件作用域只接受 64 位十六进制目录，且必须已有 objects", async (t) => {
  const bridgeHome = await temporaryDirectory("codez-session-data-bridge-");
  t.after(() => rm(bridgeHome, { recursive: true, force: true }));
  await writeAttachment(bridgeHome, ROOT, { bytes: 7 });
  await mkdir(join(bridgeHome, "not-a-scope", "attachments", "objects"), { recursive: true });
  await mkdir(join(bridgeHome, "b".repeat(64), "attachments", "staging"), { recursive: true });

  const scopes = await listBridgeAttachmentScopes(bridgeHome);
  assert.deepEqual(scopes, [join(bridgeHome, SCOPE, "attachments")]);
  assert.deepEqual(await listBridgeAttachmentScopes(join(bridgeHome, "missing")), []);
});

test("附件只按 manifest 的 sessionId 归属，删除只计真实消失的字节", async (t) => {
  const bridgeHome = await temporaryDirectory("codez-session-data-bridge-");
  t.after(() => rm(bridgeHome, { recursive: true, force: true }));
  const owned = await writeAttachment(bridgeHome, ROOT, { bytes: 7 });
  const foreign = await writeAttachment(bridgeHome, OTHER, {
    bytes: 100,
    id: "55555555-5555-4555-8555-555555555555",
  });
  const scopes = await listBridgeAttachmentScopes(bridgeHome);

  const listed = await listOwnedAttachmentObjects(scopes, new Set([ROOT, CHILD]));
  assert.equal(listed.unreadable, 0);
  assert.deepEqual(
    listed.objects.map((entry) => entry.id),
    [owned.id],
  );
  assert.equal(listed.objects[0]!.bytes, 7);
  assert.equal(listed.objects[0]!.dataPath, owned.dataPath);

  const removed = await removeAttachmentObjects(listed.objects);
  assert.equal(removed.bytes, 7);
  assert.deepEqual(removed.failed, []);
  assert.deepEqual(await listExistingPaths([owned.dataPath, owned.manifestPath]), []);
  assert.deepEqual(
    await listExistingPaths([foreign.dataPath, foreign.manifestPath]),
    [foreign.dataPath, foreign.manifestPath],
    "不属于本次会话树的对象一个字节都不能动",
  );

  // 幂等：对象已消失时按 0 字节成功。
  assert.deepEqual(await removeAttachmentObjects(listed.objects), { bytes: 0, failed: [] });
});

test("manifest 读不出时计入 unreadable，调用方据此 fail-closed", async (t) => {
  const bridgeHome = await temporaryDirectory("codez-session-data-bridge-");
  t.after(() => rm(bridgeHome, { recursive: true, force: true }));
  await writeAttachment(bridgeHome, ROOT, { bytes: 7, corrupt: true });
  const scopes = await listBridgeAttachmentScopes(bridgeHome);
  const listed = await listOwnedAttachmentObjects(scopes, new Set([ROOT]));
  assert.equal(listed.unreadable, 1);
  assert.deepEqual(listed.objects, []);
});

test("rollout 目录比预算更深时 fail-closed，不静默跳过", async (t) => {
  const codexHome = await temporaryDirectory("codez-session-data-files-");
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  await writeRollout(codexHome, ROOT, { bytes: 1 });
  // sessions/2026/11/01/x/y：y 已超出默认深度预算，跳过会让计量漏掉原生删除的文件。
  await mkdir(join(codexHome, "sessions", "2026", "11", "01", "x", "y"), { recursive: true });
  await assert.rejects(scanRolloutFiles(codexHome, new Set([ROOT])), /deeper than 4/);
  // 提高预算后可以正常扫描（说明拒绝来自深度而不是别的故障）。
  const found = await scanRolloutFiles(codexHome, new Set([ROOT]), { maxDepth: 6 });
  assert.equal((found.get(ROOT) ?? []).length, 1);
});

test("库内 rollout_path 只接受 CODEX_HOME 的两个 rollout 目录", async (t) => {
  const codexHome = await temporaryDirectory("codez-session-data-files-");
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const inside = join(codexHome, "sessions", "2026", "11", "01", `rollout-x-${ROOT}.jsonl`);
  const archived = join(codexHome, "archived_sessions", `rollout-x-${ROOT}.jsonl`);
  assert.equal(scopedRolloutPath(codexHome, inside), inside);
  assert.equal(scopedRolloutPath(codexHome, archived), archived);
  assert.equal(
    scopedRolloutPath(codexHome, join(codexHome, "memories", "memory_summary.md")),
    undefined,
  );
  assert.equal(scopedRolloutPath(codexHome, "/etc/passwd"), undefined);
  assert.equal(scopedRolloutPath(codexHome, "sessions/2026/11/01/x.jsonl"), undefined);
  assert.equal(scopedRolloutPath(codexHome, ""), undefined);
  assert.equal(
    scopedRolloutPath(codexHome, join(codexHome, "sessions", "..", "memories", "x.jsonl")),
    undefined,
    "路径穿越不能伪装成 rollout 目录内的文件",
  );
});

test("重试索引形状不符一律抛出，不返回 undefined 冒充「没有待清理后代」", async (t) => {
  const pendingRoot = join(await temporaryDirectory("codez-session-data-pending-"), "pending");
  t.after(() => rm(pendingRoot, { recursive: true, force: true }));
  const path = join(pendingRoot, `${ROOT.toLowerCase()}.json`);
  const cases: Array<[string, unknown, RegExp]> = [
    ["version 不符", { version: 2, rootId: ROOT, threadIds: [ROOT] }, /shape is invalid/],
    ["threadIds 不是数组", { version: 1, rootId: ROOT, threadIds: ROOT }, /shape is invalid/],
    ["rootId 与文件名不符", { version: 1, rootId: CHILD, threadIds: [CHILD] }, /root mismatch/],
    ["空 id 集", { version: 1, rootId: ROOT, threadIds: [] }, /size is invalid/],
    ["含非法 id", { version: 1, rootId: ROOT, threadIds: [ROOT, "../x"] }, /invalid thread id/],
    [
      "不含自己的根",
      { version: 1, rootId: ROOT, threadIds: [CHILD] },
      /does not contain its own root/,
    ],
    ["半截 JSON", undefined, /corrupt/],
  ];
  for (const [name, payload, pattern] of cases) {
    await mkdir(pendingRoot, { recursive: true });
    await writeFile(path, payload === undefined ? "{ half" : JSON.stringify(payload));
    await assert.rejects(readPendingTree(pendingRoot, ROOT), pattern, name);
  }
  // 超出 id 数量上限同样拒绝，避免用一个巨大索引把整树预检拖垮。
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      rootId: ROOT,
      threadIds: Array.from({ length: 4097 }, (_, index) =>
        index === 0 ? ROOT : `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
      ),
    }),
  );
  await assert.rejects(readPendingTree(pendingRoot, ROOT), /size is invalid/);
  // 超过字节上限时在读取前就拒绝。
  await writeFile(
    path,
    `{"version":1,"rootId":"${ROOT}","threadIds":["${ROOT}"]}${" ".repeat(300_000)}`,
  );
  await assert.rejects(readPendingTree(pendingRoot, ROOT), /too large/);
});
