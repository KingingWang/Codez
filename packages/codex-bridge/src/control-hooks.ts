import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import * as s from "@codez/shared";
import type { BridgeControlContext } from "./contract.js";
import { assertNotSymlink, writeFileAtomic } from "./control-agents-data.js";
import { ControlError } from "./control-common.js";

// Codex 用户层/项目层 hooks.json 管理（spec: specs/codex-desktop-hooks-and-commands.md）。
// Codex 原生从 ${CODEX_HOME}/hooks.json（user）与 <project>/.codex/hooks.json（project）
// 发现命令钩子，hooks/list 只读返回全部发现结果；本控制面负责在 workspace 所在机器上
// 对 hooks.json 执行安全的 read-modify-write。

const projectLayerScanSchema = z.object({
  layers: z
    .array(
      z
        .object({
          name: z.object({ type: z.string(), dotCodexFolder: z.string().optional() }),
        })
        .passthrough(),
    )
    .optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEX_HOME?.trim();
  return override ? override : join(homedir(), ".codex");
}

async function resolveHooksFilePath(
  context: BridgeControlContext,
  method: string,
  scope: s.CodezHooksConfigScope,
  dotCodexFolder?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (scope === "user") {
    return join(resolveCodexHome(env), "hooks.json");
  }
  const scan = projectLayerScanSchema.parse(
    await context.rpc.request("config/read", { cwd: context.cwd, includeLayers: true }),
  );
  const projectLayers = (scan.layers ?? []).filter(
    (layer) => layer.name.type === "project" && layer.name.dotCodexFolder,
  );
  let folder: string;
  if (dotCodexFolder !== undefined) {
    const defaultDotCodex = join(context.cwd, ".codex");
    if (
      dotCodexFolder !== defaultDotCodex &&
      !projectLayers.some((layer) => layer.name.dotCodexFolder === dotCodexFolder)
    ) {
      throw new ControlError(-32602, `${method}: unknown project config folder`, {
        method,
        reason: "unknown_dot_codex_folder",
      });
    }
    folder = dotCodexFolder;
  } else {
    folder = projectLayers[0]?.name.dotCodexFolder ?? join(context.cwd, ".codex");
  }
  return join(folder, "hooks.json");
}

function normalizeMatcher(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStatusMessage(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildHandlerRecord(entry: s.CodezHookCommandEntry): Record<string, unknown> {
  const command = entry.command.trim();
  if (!command) {
    throw new ControlError(-32602, "hooks/configWrite: command cannot be blank", {
      method: "hooks/configWrite",
      reason: "blank_command",
    });
  }
  const handler: Record<string, unknown> = {
    type: "command",
    command,
  };
  if (entry.timeoutSec !== undefined && entry.timeoutSec !== 600) {
    handler["timeout"] = entry.timeoutSec;
  }
  if (entry.async === true) {
    handler["async"] = true;
  }
  const statusMessage = normalizeStatusMessage(entry.statusMessage);
  if (statusMessage) {
    handler["statusMessage"] = statusMessage;
  }
  return handler;
}

function handlerMatchesTarget(
  groupMatcher: string | undefined,
  handler: Record<string, unknown>,
  target: s.CodezHookCommandEntry,
): boolean {
  if (handler["type"] !== "command") return false;
  const command = typeof handler["command"] === "string" ? handler["command"].trim() : "";
  if (command !== target.command.trim()) return false;
  const targetMatcher = normalizeMatcher(target.matcher);
  if ((groupMatcher ?? undefined) !== targetMatcher) return false;
  return true;
}

function removeMatchingHook(
  hooksRoot: Record<string, unknown>,
  target: s.CodezHookCommandEntry,
): boolean {
  const rawGroups = hooksRoot[target.event];
  if (!Array.isArray(rawGroups)) return false;
  let removed = false;
  const nextGroups: Record<string, unknown>[] = [];

  for (const rawGroup of rawGroups) {
    if (!isRecord(rawGroup)) continue;
    const groupMatcher = normalizeMatcher(
      typeof rawGroup["matcher"] === "string" ? rawGroup["matcher"] : undefined,
    );
    const rawHandlers = Array.isArray(rawGroup["hooks"]) ? rawGroup["hooks"] : [];
    const nextHandlers: unknown[] = [];
    for (const rawHandler of rawHandlers) {
      if (
        !removed &&
        isRecord(rawHandler) &&
        handlerMatchesTarget(groupMatcher, rawHandler, target)
      ) {
        removed = true;
        continue;
      }
      nextHandlers.push(rawHandler);
    }
    if (nextHandlers.length > 0) {
      nextGroups.push({
        ...rawGroup,
        hooks: nextHandlers,
      });
    }
  }

  if (nextGroups.length > 0) {
    hooksRoot[target.event] = nextGroups;
  } else {
    delete hooksRoot[target.event];
  }
  return removed;
}

function insertHookEntry(
  hooksRoot: Record<string, unknown>,
  entry: s.CodezHookCommandEntry,
): void {
  const matcher = normalizeMatcher(entry.matcher);
  const handler = buildHandlerRecord(entry);
  const rawGroups = Array.isArray(hooksRoot[entry.event])
    ? [...(hooksRoot[entry.event] as unknown[])]
    : [];

  // 查找同 matcher 的既有 matcherGroup 并合并；避免重复命中完全相同的 command。
  for (let index = 0; index < rawGroups.length; index += 1) {
    const group = rawGroups[index];
    if (!isRecord(group)) continue;
    const groupMatcher = normalizeMatcher(
      typeof group["matcher"] === "string" ? group["matcher"] : undefined,
    );
    if (groupMatcher !== matcher) continue;
    const handlers = Array.isArray(group["hooks"]) ? [...group["hooks"]] : [];
    const existingIndex = handlers.findIndex(
      (candidate) =>
        isRecord(candidate) && handlerMatchesTarget(groupMatcher, candidate, entry),
    );
    if (existingIndex >= 0) {
      handlers[existingIndex] = handler;
    } else {
      handlers.push(handler);
    }
    rawGroups[index] = {
      ...group,
      ...(matcher ? { matcher } : {}),
      hooks: handlers,
    };
    hooksRoot[entry.event] = rawGroups;
    return;
  }

  rawGroups.push({
    ...(matcher ? { matcher } : {}),
    hooks: [handler],
  });
  hooksRoot[entry.event] = rawGroups;
}

export async function writeCodexHooksConfig(
  context: BridgeControlContext,
  params: s.CodezHooksConfigWriteParams,
  env: NodeJS.ProcessEnv = process.env,
): Promise<s.CodezHooksConfigWriteResult> {
  const method = "hooks/configWrite";
  if (params.action === "add" && !params.hook) {
    throw new ControlError(-32602, `${method}: add requires hook`, {
      method,
      reason: "missing_hook",
    });
  }
  if (params.action === "update" && (!params.target || !params.hook)) {
    throw new ControlError(-32602, `${method}: update requires target and hook`, {
      method,
      reason: "missing_target_or_hook",
    });
  }
  if (params.action === "delete" && !params.target) {
    throw new ControlError(-32602, `${method}: delete requires target`, {
      method,
      reason: "missing_target",
    });
  }

  const hooksFilePath = await resolveHooksFilePath(
    context,
    method,
    params.scope,
    params.dotCodexFolder,
    env,
  );
  await mkdir(dirname(hooksFilePath), { recursive: true });
  await assertNotSymlink(hooksFilePath, method);

  let root: Record<string, unknown> = {};
  try {
    const raw = await readFile(hooksFilePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new ControlError(-32000, `${method}: hooks.json root must be a JSON object`, {
        method,
        reason: "invalid_hooks_json",
      });
    }
    root = { ...parsed };
  } catch (error) {
    if (error instanceof ControlError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ControlError(
        -32000,
        `${method}: failed to read hooks.json (${error instanceof Error ? error.message : String(error)})`,
        { method, reason: "read_failed" },
      );
    }
  }

  const hooksRoot: Record<string, unknown> = isRecord(root["hooks"])
    ? { ...(root["hooks"] as Record<string, unknown>) }
    : {};

  if (params.action === "delete") {
    const removed = removeMatchingHook(hooksRoot, params.target!);
    if (!removed) {
      throw new ControlError(-32602, `${method}: target hook not found in ${hooksFilePath}`, {
        method,
        reason: "not_found",
      });
    }
  } else if (params.action === "update") {
    const removed = removeMatchingHook(hooksRoot, params.target!);
    if (!removed) {
      throw new ControlError(-32602, `${method}: target hook not found in ${hooksFilePath}`, {
        method,
        reason: "not_found",
      });
    }
    insertHookEntry(hooksRoot, params.hook!);
  } else {
    insertHookEntry(hooksRoot, params.hook!);
  }

  root["hooks"] = hooksRoot;
  await writeFileAtomic(hooksFilePath, `${JSON.stringify(root, null, 2)}\n`);
  return s.codezHooksConfigWriteResultSchema.parse({ hooksFilePath });
}
