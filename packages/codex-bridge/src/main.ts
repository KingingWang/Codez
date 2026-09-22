import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { createCodexProcess } from "./codex-process.js";
import { RpcFramer, type RpcEnvelope } from "./rpc-framing.js";
import { HostOutput } from "./host-output.js";
import { BridgeRuntime } from "./bridge-runtime.js";

async function main(): Promise<void> {
  // Windows 的 cwd 可保留 junction/短路径拼写；执行路径统一为物理目录，身份仍由 Host 指定。
  const cwd = await realpath(process.cwd());
  const workspaceId = process.env.ZCODE_WORKSPACE_IDENTITY?.trim() || cwd;
  const scope = createHash("sha256").update(workspaceId).digest("hex");
  const stateRoot = join(
    process.env.ZCODE_CODEX_BRIDGE_HOME || join(homedir(), ".zcode-codex", "bridge"),
    scope,
  );
  const rpc = createCodexProcess({
    executable: process.env.ZCODE_CODEX_COMMAND?.trim() || "codex",
    cwd,
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
    if (runtime) await runtime.close();
    else await rpc.close();
  };
  const fatal = (error: Error) => {
    if (process.env.ZCODE_CODEX_BRIDGE_TEST_DIAGNOSTICS === "1")
      process.stderr.write(`${error.stack}\n`);
    void stop(true);
  };
  process.stdout.on("error", fatal);
  rpc.onClose((error) => {
    if (!stopping) fatal(error);
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
          await write({ id, result: response.result });
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

void main().catch(() => {
  process.stderr.write(
    "Unable to initialize the Codex desktop runtime. Check the executable and native configuration.\n",
  );
  process.exitCode = 1;
});
