import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { createCodexProcess } from "./codex-process.js";
import { RpcFramer, type RpcEnvelope } from "./rpc-framing.js";
import { CodexTransportError } from "./rpc-errors.js";
import { HostOutput } from "./host-output.js";
import { BridgeRuntime } from "./bridge-runtime.js";
import { CODEZ_NATIVE_BROWSER_CUA_MCP_ENTRY_MODE } from "@codez/shared";
import { parseNativeBrowserCuaFacts, runNativeBrowserCuaMcp } from "./native-browser-cua-mcp.js";
import { describeBridgeFailure, type BridgeFailureOrigin } from "./diagnostics.js";

async function main(): Promise<void> {
  if (process.argv[2] === CODEZ_NATIVE_BROWSER_CUA_MCP_ENTRY_MODE) {
    await runNativeBrowserCuaMcp();
    return;
  }
  // Windows 的 cwd 可保留 junction/短路径拼写；执行路径统一为物理目录，身份仍由 Host 指定。
  const cwd = await realpath(process.cwd());
  const workspaceId = process.env.CODEZ_WORKSPACE_IDENTITY?.trim() || cwd;
  const scope = createHash("sha256").update(workspaceId).digest("hex");
  const stateRoot = join(
    process.env.CODEZ_CODEX_BRIDGE_HOME || join(homedir(), ".codez-codex", "bridge"),
    scope,
  );
  const rpc = createCodexProcess({
    executable: process.env.CODEZ_CODEX_COMMAND?.trim() || "codex",
    cwd,
    onFrameDropped: (frame) => {
      // 只输出结构化下界与字节数；前缀内容可能含用户数据，永不记录。
      process.stderr.write(
        `Codex desktop bridge dropped an oversized native frame (observedBytes>=${frame.observedBytes}); affected requests fail explicitly without retry.\n`,
      );
    },
  });
  let runtime: BridgeRuntime | undefined;
  let stopping = false;
  let inFlight = 0;
  const output = new HostOutput((encoded, done) => {
    process.stdout.write(encoded, done);
  });
  const write = (frame: RpcEnvelope) => output.write(frame);
  const stop = async (failed: boolean) => {
    if (stopping) return;
    stopping = true;
    process.stdin.pause();
    if (failed) {
      process.stderr.write(
        "Codex desktop bridge stopped: runtime/transport failure. No request was retried.\n",
      );
      process.exitCode = 1;
    }
    try {
      if (runtime) await runtime.close();
      else await rpc.close();
    } catch (error) {
      // 关闭失败也必须留在受控退出路径；不能让未处理拒绝输出原生异常中的私密内容。
      process.stderr.write(
        `Codex desktop bridge failure: ${JSON.stringify(describeBridgeFailure(error, "shutdown"))}\n`,
      );
      process.exitCode = 1;
    }
  };
  const fatal = (error: Error, origin?: BridgeFailureOrigin) => {
    if (stopping) return;
    process.stderr.write(
      `Codex desktop bridge failure: ${JSON.stringify(describeBridgeFailure(error, origin))}\n`,
    );
    if (process.env.CODEZ_CODEX_BRIDGE_TEST_DIAGNOSTICS === "1")
      process.stderr.write(`${error.stack}\n`);
    void stop(true);
  };
  process.stdout.on("error", fatal);
  rpc.onClose((error) => {
    if (!stopping) fatal(error, "native-transport");
  });
  process.once("SIGTERM", () => {
    void stop(false);
  });
  process.once("SIGINT", () => {
    void stop(false);
  });
  await rpc.initialize();
  runtime = new BridgeRuntime({
    rpc,
    cwd,
    workspaceId,
    stateRoot,
    notify: (method, params) => write({ method, params }),
    fatal,
    nativeBrowserCua: parseNativeBrowserCuaFacts(),
  });
  const framer = new RpcFramer();
  const receive = (message: RpcEnvelope): boolean => {
    if (stopping) return false;
    if (!message.method || message.id === undefined) return true;
    if (++inFlight > 256) {
      fatal(new Error("Too many pending host requests"));
      return false;
    }
    const id = message.id;
    void runtime!
      .request(message.method, message.params)
      .then(
        async (response) => {
          try {
            await write({ id, result: response.result });
          } catch (error) {
            // 超大响应（如全量 plugin/list 透传）只让该请求失败，
            // 不能升级为整桥致命错误；失败语义显式，不重试。
            if (!(error instanceof CodexTransportError) || error.code !== "LIMIT") throw error;
            await write({
              id,
              error: { code: -32000, message: "Codex response exceeds the bridge frame limit" },
            });
          }
          await response.afterResponse?.();
        },
        async (error: unknown) => {
          const code =
            error && typeof error === "object" && "code" in error && typeof error.code === "number"
              ? error.code
              : -32000;
          await write({
            id,
            error: {
              code,
              message: error instanceof Error ? error.message : "Codex adapter request failed",
            },
          });
        },
      )
      .catch(fatal)
      .finally(() => {
        inFlight -= 1;
      });
    return true;
  };
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      framer.push(chunk, receive);
    } catch (error) {
      fatal(error as Error);
    }
  });
  process.stdin.once("end", () => {
    try {
      framer.end();
      void stop(false);
    } catch (error) {
      fatal(error as Error);
    }
  });
  process.stdin.once("error", fatal);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Codex desktop bridge failure: ${JSON.stringify(describeBridgeFailure(error, "startup"))}\n`,
  );
  process.stderr.write(
    "Unable to initialize the Codex desktop runtime. Check the executable and native configuration.\n",
  );
  process.exitCode = 1;
});
