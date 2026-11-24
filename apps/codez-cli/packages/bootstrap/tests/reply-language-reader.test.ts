import { expect, it, vi } from "vitest";
// 大型工厂模块在准备阶段加载，避免转换开销占用端口行为用例的超时预算。
import { createWorkspaceCodezApp } from "../src/codez-protocol/workspace-model-runtime.js";
import {
  ProtocolRequestError,
  type CodezProtocolAgentServerContext,
} from "../src/codez-protocol/server-types.js";
import type { CodezAppOptions } from "../src/app/types.js";
import { CODEZ_REPLY_LANGUAGE_REQUEST_TIMEOUT_MS, codezProtocolMethods } from "@codez/shared";

const workspace = {
  workspacePath: "/work",
  workspaceIdentity: "local:/work",
  workspaceKey: "local:/work",
};
const input = { sessionId: "session", traceContext: { traceId: "test-trace" } };

async function readerWith(requestClient: ReturnType<typeof vi.fn>) {
  const createCodezApp = vi.fn(async (_options: Omit<CodezAppOptions, "providerRegistry">) => ({}));
  await createWorkspaceCodezApp(
    {
      deps: { createCodezApp },
      requestClient,
      notify: vi.fn(),
    } as unknown as CodezProtocolAgentServerContext,
    workspace,
    {},
  );
  return createCodezApp.mock.calls[0]![0].readReplyLanguage!;
}

it("reads the Host reply language with a dedicated bounded request", async () => {
  const requestClient = vi.fn(async () => ({ language: "Português (Brasil)" }));
  const read = await readerWith(requestClient);
  const controller = new AbortController();
  await expect(read({ ...input, signal: controller.signal })).resolves.toBe("Português (Brasil)");
  expect(requestClient).toHaveBeenCalledWith(
    codezProtocolMethods.sessionReadReplyLanguage,
    { sessionId: "session" },
    expect.anything(),
    expect.objectContaining({
      signal: controller.signal,
      timeoutMs: CODEZ_REPLY_LANGUAGE_REQUEST_TIMEOUT_MS,
    }),
  );
});

it("passes an unset reply language through as null", async () => {
  const read = await readerWith(vi.fn(async () => ({ language: null })));
  await expect(read(input)).resolves.toBeNull();
});

it("leaves request failures to the runtime, which skips the announcement", async () => {
  const failure = new ProtocolRequestError(-32601, "Method not found");
  const read = await readerWith(
    vi.fn(async () => {
      throw failure;
    }),
  );
  await expect(read(input)).rejects.toBe(failure);
});
