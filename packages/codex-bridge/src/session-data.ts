// Codex 后端的 v4/storage/sessionData/measure|purge 执行面（specs/codex-session-data-purge.md）。
//
// 这是一条已授权的**本机全局** session-data 控制面：入参只有 sessionIds 与 directories，
// 载体 bridge 的 cwd 经常不是目标会话的 cwd（冷项目、已删目录、管理面合成 cwd），
// 所以绝不按载体 cwd 过滤，也不用 directories 冒充会话 cwd；每个会话读自己的原生 metadata.cwd
// 作为删除原语的校验输入。远端禁用留在 services（project.data-local-only）。
//
// 删除只有一次原生 `thread/delete(root)`：整树级联由原生负责（thread_delete.rs:39-62），
// bridge 不逐个删子线程，也不复用会对子线程 fail-closed 的 deleteBridgeThread。
import { dirname, isAbsolute } from "node:path";
import {
  v4SessionDataMeasureResultSchema,
  v4SessionDataParamsSchema,
  v4SessionDataPurgeResultSchema,
  type V4SessionDataMeasureResult,
  type V4SessionDataPurgeResult,
} from "@codez/shared/codez-protocol-v4";
import type { CodexRpcPort } from "./contract.js";
import { codexThreadSchema } from "./codex-types.js";
import { decorateNativeThread } from "./command-input.js";
import { resolveCodexHomeDir } from "./default-codex-config.js";
import { CodexRpcError } from "./rpc-errors.js";
import {
  listBridgeAttachmentScopes,
  listOwnedAttachmentObjects,
  removeAttachmentObjects,
  type AttachmentObject,
} from "./session-data-attachments.js";
import {
  clearPendingTree,
  listExistingPaths,
  measureExistingFiles,
  readPendingTree,
  scanRolloutFiles,
  scopedRolloutPath,
  writePendingTree,
} from "./session-data-files.js";
import {
  SessionDataFault,
  readQueuedThreadIds,
  readThreadRolloutPaths,
} from "./session-data-native-db.js";
import {
  isMissingNativeThreadError,
  resolveSessionTree,
  type SessionTree,
  type SessionTreeStore,
} from "./session-data-tree.js";

/** 树枚举的有界并发；破坏性步骤本身逐会话串行。 */
const TREE_CONCURRENCY = 4;

export interface SessionDataStore extends SessionTreeStore {
  remove(id: string): void;
}

export interface SessionDataDeps {
  rpc: CodexRpcPort;
  store: SessionDataStore;
  /** 载体 bridge 自己的事实：只用于派生默认路径与诊断，绝不作为过滤条件。 */
  carrier: { cwd: string; workspaceId: string; stateRoot: string };
  env?: NodeJS.ProcessEnv;
  /** 测试可注入；缺省按 bridge 进程环境解析 CODEX_HOME。 */
  codexHome?: string;
  /** bridge 数据根（main.ts:49-50 同一表达式）；缺省取 carrier.stateRoot 的父目录。 */
  bridgeHome?: string;
  limits?: { maxMembers?: number; maxLiveReads?: number; maxQueueChecks?: number };
}

interface SessionFacts {
  tree?: SessionTree;
  fault?: SessionDataFault;
  /** threadId → rollout 绝对路径（含 `.jsonl` 与 `.jsonl.zst`）。 */
  rollouts: Map<string, string[]>;
  /** 归属该会话树的 bridge 附件对象。 */
  attachments: AttachmentObject[];
  unreadableManifests: number;
}

function failureCode(error: unknown): string {
  if (error instanceof SessionDataFault) return error.code;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code ? code : "unknown";
}

function bridgeHomeOf(deps: SessionDataDeps): string {
  return deps.bridgeHome ?? dirname(deps.carrier.stateRoot);
}

function codexHomeOf(deps: SessionDataDeps): string {
  return deps.codexHome ?? resolveCodexHomeDir(deps.env ?? process.env);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<R>,
): Promise<R[]> {
  // 不用 new Array(n) 预留槽位：稀疏数组会让 lint 与后续遍历语义含糊，按索引写回 Map 更明确。
  const results = new Map<number, R>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results.set(index, await run(values[index]!));
      }
    }),
  );
  return values.map((_, index) => results.get(index)!);
}

/**
 * 删除原语前的 metadata 校验：原生必须给出非空绝对 cwd，且目标必须是根线程。
 * 这是「读原生 metadata.cwd 作为验证过的删除原语输入」的落点；相对路径、空值或子线程一律拒绝，
 * 避免把身份不明的线程当成本机会话删除，也避免 Host 的整树记账错位。
 */
function assertDeletableRoot(tree: SessionTree): void {
  if (tree.rootIsChild)
    throw new SessionDataFault("not-a-root-thread", "session is a descendant of another thread");
  if (tree.rootAbsent) return;
  if (typeof tree.rootCwd !== "string" || tree.rootCwd.trim().length === 0)
    throw new SessionDataFault("invalid-thread-metadata", "native thread has no cwd");
  if (!isAbsolute(tree.rootCwd))
    throw new SessionDataFault("invalid-thread-metadata", "native thread cwd is not absolute");
}

/**
 * 逐会话收集树与磁盘事实。measure 要求全部成功（没有 failed 通道），purge 允许单会话失败并继续。
 * rollout 目录与附件作用域整批只走一次，不按会话重复遍历。
 */
async function collectFacts(
  deps: SessionDataDeps,
  rootIds: readonly string[],
  options: { tolerateFaults: boolean },
): Promise<Map<string, SessionFacts>> {
  const codexHome = codexHomeOf(deps);
  const facts = new Map<string, SessionFacts>(
    rootIds.map((id) => [
      id,
      { rollouts: new Map<string, string[]>(), attachments: [], unreadableManifests: 0 },
    ]),
  );
  const resolved = await mapWithConcurrency(rootIds, TREE_CONCURRENCY, async (rootId) => {
    try {
      const tree = await resolveSessionTree(rootId, {
        rpc: deps.rpc,
        codexHome,
        store: deps.store,
        limits: deps.limits,
      });
      assertDeletableRoot(tree);
      return { rootId, tree };
    } catch (error) {
      const fault =
        error instanceof SessionDataFault
          ? error
          : new SessionDataFault("tree-unknown", (error as Error).message);
      if (!options.tolerateFaults) throw fault;
      return { rootId, fault };
    }
  });

  const trees = new Map<string, SessionTree>();
  for (const entry of resolved) {
    const fact = facts.get(entry.rootId)!;
    if (entry.fault) fact.fault = entry.fault;
    else {
      fact.tree = entry.tree;
      trees.set(entry.rootId, entry.tree);
    }
  }
  if (trees.size === 0) return facts;

  // 归属表一律用小写线程 id 做键：磁盘与 SQLite 事实都是小写 UUID，而 Host 传进来的会话 id
  // 可能是另一种拼写；不规范化会让附件与 rollout 静默对不上号（该删的没删、该计的没计）。
  const ownerOfThread = new Map<string, string>();
  for (const [rootId, tree] of trees)
    for (const id of tree.threadIds) {
      const key = id.toLowerCase();
      if (!ownerOfThread.has(key)) ownerOfThread.set(key, rootId);
    }
  const threadIds = new Set(ownerOfThread.keys());

  const rollouts = await scanRolloutFiles(codexHome, threadIds);
  for (const [threadId, paths] of rollouts) {
    const rootId = ownerOfThread.get(threadId.toLowerCase());
    if (rootId) facts.get(rootId)!.rollouts.set(threadId, paths);
  }
  // state db 记录的当前 rollout 一并纳入候选：原生按 rollout **payload** 的 session_meta.id
  // 归属文件，回退产生的 replacement 文件名带的是另一个 UUID（pinned delete_thread.rs 测试
  // delete_thread_rejects_reference_to_reverted_rollout：文件名 321、payload id 320），
  // 只按文件名前段匹配会漏计这类文件。
  for (const [threadId, path] of await readThreadRolloutPaths(codexHome, [...threadIds])) {
    const rootId = ownerOfThread.get(threadId.toLowerCase());
    const scoped = path ? scopedRolloutPath(codexHome, path) : undefined;
    if (!rootId || !scoped) continue;
    const known = facts.get(rootId)!.rollouts.get(threadId) ?? [];
    if (!known.includes(scoped)) facts.get(rootId)!.rollouts.set(threadId, [...known, scoped]);
  }
  const scopes = await listBridgeAttachmentScopes(bridgeHomeOf(deps));
  const { objects, unreadable } = await listOwnedAttachmentObjects(scopes, threadIds);
  for (const entry of objects) {
    const rootId = ownerOfThread.get(entry.sessionId.toLowerCase());
    if (rootId) facts.get(rootId)!.attachments.push(entry);
  }
  // 无法归属的 manifest 不能假装不存在：整批都按「无法证明」处理（fail-closed）。
  for (const rootId of trees.keys()) facts.get(rootId)!.unreadableManifests = unreadable;
  return facts;
}

/** 删前计量：只算当前真实存在、且文件名语法证明归属的 rollout。 */
async function measureRollouts(
  paths: readonly string[],
): Promise<{ bytes: number; present: string[] }> {
  const sizes = await measureExistingFiles(paths);
  let bytes = 0;
  for (const size of sizes.values()) bytes += size;
  return { bytes, present: [...sizes.keys()] };
}

export async function measureSessionData(
  rawParams: unknown,
  deps: SessionDataDeps,
): Promise<V4SessionDataMeasureResult> {
  const params = v4SessionDataParamsSchema.parse(rawParams);
  const rootIds = [...new Set(params.sessionIds)];
  // measure 没有 failed 通道：任何无法证明的读失败都让整条请求失败，Host 据此隐藏选项，
  // 绝不返回假 0（那会让用户以为「没有数据可删」）。
  const facts = await collectFacts(deps, rootIds, { tolerateFaults: false });
  const sessions: V4SessionDataMeasureResult["sessions"] = [];
  for (const rootId of rootIds) {
    const fact = facts.get(rootId)!;
    if (fact.unreadableManifests > 0)
      throw new SessionDataFault(
        "attachment-manifest-unreadable",
        "cannot prove attachment ownership",
      );
    const rollouts = await measureRollouts([...fact.rollouts.values()].flat());
    const attachmentBytes = fact.attachments.reduce((sum, entry) => sum + entry.bytes, 0);
    sessions.push({ sessionId: rootId, bytes: rollouts.bytes + attachmentBytes });
  }
  // Codex 后端没有 Codez 目录级记忆文件：原生记忆是 state db 行，随 thread/delete 删除且按合同
  // 不计字节；`$CODEX_HOME/memories` 是全局的、项目内 AGENTS.md 是用户文件，两者都绝不删。
  return v4SessionDataMeasureResultSchema.parse({
    sessions,
    memory: params.directories.map((directory) => ({
      workspacePath: directory.workspacePath,
      bytes: 0,
    })),
  });
}

async function listLoadedIds(rpc: CodexRpcPort): Promise<Set<string>> {
  let response: unknown;
  try {
    response = await rpc.request("thread/loaded/list", {});
  } catch (error) {
    if (isMissingNativeThreadError(error)) return new Set();
    throw new SessionDataFault("recheck-unavailable", "thread/loaded/list failed");
  }
  const data = (response as { data?: unknown } | null)?.data;
  if (!Array.isArray(data))
    throw new SessionDataFault("recheck-unavailable", "unreadable thread/loaded/list response");
  return new Set(data.filter((id): id is string => typeof id === "string"));
}

async function readNativeActivity(
  rpc: CodexRpcPort,
  id: string,
): Promise<"running" | "idle" | "absent"> {
  let response: unknown;
  try {
    response = await rpc.request("thread/read", { threadId: id });
  } catch (error) {
    if (isMissingNativeThreadError(error)) return "absent";
    throw new SessionDataFault("recheck-unavailable", `thread/read failed for ${id}`);
  }
  const parsed = codexThreadSchema.safeParse(decorateNativeThread(response));
  // 形状不认识就不能断言空闲：门禁复检必须 fail-closed。
  if (!parsed.success) throw new SessionDataFault("recheck-unavailable", `unreadable thread ${id}`);
  if (parsed.data.status.type === "active") return "running";
  return parsed.data.turns.some((turn) => turn.status === "inProgress") ? "running" : "idle";
}

/**
 * 删除前最后一次门禁复检（TOCTOU 收口）。
 * 预检到原生真正删除之间可能有新 turn 被 admit，而原生 thread/delete 对活跃线程是**强制关停**
 * 而不是拒绝（thread_processor.rs:1069-1095），所以调用前必须再确认一次：
 * 整树重读持久化队列、loaded 集合里的树成员重读原生 status、bridge 内存事实重看一遍。
 * 复检自身失败 = 无法证明空闲 → 抛错，绝不带着未知状态发起删除。
 */
async function recheckTreeIdle(
  deps: SessionDataDeps,
  codexHome: string,
  tree: SessionTree,
): Promise<"idle" | "running"> {
  for (const member of tree.members) {
    if (member.writerConflict) throw new SessionDataFault("writer-conflict", member.id);
    if (deps.store.observedThreadActive(member.id) === true) return "running";
  }
  if ((await readQueuedThreadIds(codexHome, tree.threadIds)).size > 0) return "running";
  const loaded = await listLoadedIds(deps.rpc);
  for (const member of tree.members) {
    if (!loaded.has(member.id)) continue;
    if ((await readNativeActivity(deps.rpc, member.id)) === "running") return "running";
  }
  return "idle";
}

/** 原生删除结果分类：只有明确成功或明确不存在才能报 deleted。 */
type DeleteOutcome =
  | { kind: "deleted" }
  | { kind: "absent" }
  | { kind: "referenced" }
  | { kind: "failed"; code: string }
  | { kind: "unknown" };

async function deleteTree(
  deps: SessionDataDeps,
  codexHome: string,
  tree: SessionTree,
): Promise<DeleteOutcome> {
  try {
    await deps.rpc.request("thread/delete", { threadId: tree.rootId });
    return { kind: "deleted" };
  } catch (error) {
    if (error instanceof SessionDataFault) return { kind: "failed", code: error.code };
    // 传输错误/超时：原生可能已经删完，也可能根本没开始。结果未知就不猜、不盲重试、
    // 不写 tombstone；pending 索引留着，下一次重试先重新读原生事实再决定。
    if (!(error instanceof CodexRpcError)) return { kind: "unknown" };
    const message = error.message;
    if (message.includes("forked history still references it")) return { kind: "referenced" };
    if (message.includes("thread not found")) return { kind: "absent" };
    // ephemeral 根没有落盘事实；但有后代时原生在删任何行之前就返回了，整树还活着。
    if (message.includes("thread is not persisted and cannot be deleted"))
      return tree.threadIds.length > 1
        ? { kind: "failed", code: "ephemeral-with-descendants" }
        : { kind: "absent" };
    if (message.includes("no rollout found")) {
      // 这条不是幂等成功：它在删任何行之前返回，state db 行与后代都还在（thread_delete.rs:88-125）。
      const existing = await readThreadRolloutPaths(codexHome, tree.threadIds);
      return existing.size > 0
        ? { kind: "failed", code: "rollout-missing-rows-remain" }
        : { kind: "absent" };
    }
    return { kind: "failed", code: "native-delete-rejected" };
  }
}

async function purgeOne(
  deps: SessionDataDeps,
  codexHome: string,
  pendingRoot: string,
  rootId: string,
  fact: SessionFacts,
  result: V4SessionDataPurgeResult,
): Promise<void> {
  if (fact.fault) {
    result.failed.push({ sessionId: rootId, code: fact.fault.code });
    return;
  }
  const tree = fact.tree!;
  if (tree.members.some((member) => member.writerConflict)) {
    result.failed.push({ sessionId: rootId, code: "writer-conflict" });
    return;
  }
  if (tree.members.some((member) => member.activity === "running")) {
    result.kept.push({ sessionId: rootId, reason: "running" });
    return;
  }
  // 无法证明整树空闲就不删：合同只有 running/referenced 两种保留原因，
  // 「不知道」必须落到 failed，Host 保留任务行并可重试。
  if (tree.members.some((member) => member.activity === "unknown")) {
    result.failed.push({ sessionId: rootId, code: "activity-unknown" });
    return;
  }
  if (fact.unreadableManifests > 0) {
    result.failed.push({ sessionId: rootId, code: "attachment-manifest-unreadable" });
    return;
  }

  // 上一次失败留下的整树 id 集：原生行可能已删而附件还在，必须靠索引找回后代。
  const pending = await readPendingTree(pendingRoot, rootId);
  const threadIds = [...new Set([...tree.threadIds, ...(pending?.threadIds ?? [])])];
  // 附件 manifest 里的 sessionId 一律小写，比对前必须规范化，否则大写拼写会静默漏删。
  const idSet = new Set(threadIds.map((id) => id.toLowerCase()));
  const attachments = fact.attachments.filter((entry) => idSet.has(entry.sessionId));
  if (pending) {
    const scopes = await listBridgeAttachmentScopes(bridgeHomeOf(deps));
    const extra = await listOwnedAttachmentObjects(scopes, idSet);
    if (extra.unreadable > 0) {
      result.failed.push({ sessionId: rootId, code: "attachment-manifest-unreadable" });
      return;
    }
    // 去重键必须是 scope 内的具体路径：不同 scope 可能出现同 id 的对象，只按 id 去重会漏删一份。
    const known = new Set(attachments.map((entry) => entry.dataPath));
    for (const entry of extra.objects) if (!known.has(entry.dataPath)) attachments.push(entry);
  }

  // 计量必须在删除之前：原生删除成功后文件就没了，删后再量只能得到 0。
  const rollouts = await measureRollouts([...fact.rollouts.values()].flat());

  // 先落重试索引再动任何数据：索引写不进去就不开始破坏性步骤。
  await writePendingTree(pendingRoot, { rootId, threadIds, updatedAt: Date.now() });

  if ((await recheckTreeIdle(deps, codexHome, tree)) === "running") {
    result.kept.push({ sessionId: rootId, reason: "running" });
    return;
  }
  const outcome = await deleteTree(deps, codexHome, tree);
  if (outcome.kind === "referenced") {
    result.kept.push({ sessionId: rootId, reason: "referenced" });
    return;
  }
  if (outcome.kind === "unknown") {
    result.failed.push({ sessionId: rootId, code: "delete-result-unknown" });
    return;
  }
  if (outcome.kind === "failed") {
    result.failed.push({ sessionId: rootId, code: outcome.code });
    return;
  }

  // 只统计确认从磁盘消失的文件：原生不报字节，删前计量 + 删后复查才是可审计的口径。
  // CODEX_HOME 里的 rollout 只有原生是写者，残留时不自己 unlink，按失败保留重试。
  // 先证明原生把整棵树的持久行都删干净了：行的删除发生在所有 rollout 移除之后
  // （delete_thread.rs:134-136），所以「行还在」就等于「原生没删完」，此时绝不能清附件。
  const rows = await readThreadRolloutPaths(codexHome, threadIds);
  if (rows.size > 0) {
    result.failed.push({ sessionId: rootId, code: "native-rows-remain" });
    return;
  }
  if ((await listExistingPaths(rollouts.present)).length > 0) {
    result.failed.push({ sessionId: rootId, code: "rollout-remains" });
    return;
  }
  const removed = await removeAttachmentObjects(attachments);
  if (removed.failed.length > 0) {
    result.failed.push({ sessionId: rootId, code: removed.failed[0]!.code });
    return;
  }
  await clearPendingTree(pendingRoot, rootId);
  // 全部成功才写 tombstone：后续 v4/sessionsIndex/reconcile 据此确认删除。
  for (const id of threadIds) deps.store.remove(id);
  // rollout 已复查为全部消失（否则上面已经按失败返回），附件只算 removeAttachmentObjects
  // 确认删掉的字节；两者相加就是这一次真正从磁盘释放的量。
  result.deleted.push({ sessionId: rootId, bytes: rollouts.bytes + removed.bytes });
}

export async function purgeSessionData(
  rawParams: unknown,
  deps: SessionDataDeps,
): Promise<V4SessionDataPurgeResult> {
  const params = v4SessionDataParamsSchema.parse(rawParams);
  const codexHome = codexHomeOf(deps);
  const pendingRoot = `${bridgeHomeOf(deps)}/session-data-pending`;
  const rootIds = [...new Set(params.sessionIds)];
  const result: V4SessionDataPurgeResult = { deleted: [], kept: [], failed: [], memory: [] };
  const facts = await collectFacts(deps, rootIds, { tolerateFaults: true });
  // 破坏性步骤逐会话串行：一个会话的失败不影响其他会话，也不与另一个 purge 交错。
  for (const rootId of rootIds) {
    try {
      await purgeOne(deps, codexHome, pendingRoot, rootId, facts.get(rootId)!, result);
    } catch (error) {
      result.failed.push({ sessionId: rootId, code: failureCode(error) });
    }
  }
  // 目录级记忆：Codex 后端没有可删的目录记忆文件，逐项回 0（不触碰用户文件与全局 memories）。
  for (const directory of params.directories)
    result.memory.push({ workspacePath: directory.workspacePath, bytes: 0 });
  return v4SessionDataPurgeResultSchema.parse(result);
}
