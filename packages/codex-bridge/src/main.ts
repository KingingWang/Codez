import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { createCodexProcess } from "./codex-process.js";
import { RpcFramer, type RpcEnvelope } from "./rpc-framing.js";
import { CodexTransportError } from "./rpc-errors.js";
import { HostOutput } from "./host-output.js";
import { BridgeRuntime } from "./bridge-runtime.js";
import {
  CODEZ_CODEX_UPDATE_PLAN_ENABLED_ENV_KEY,
  CODEZ_DESKTOP_MCP_SERVERS_ENV_KEY,
  desktopCodexMcpServersSchema,
  CODEZ_NATIVE_BROWSER_CUA_MCP_ENTRY_MODE,
  CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
} from "@codez/shared";
import { parseNativeBrowserCuaFacts, runNativeBrowserCuaMcp } from "./native-browser-cua-mcp.js";
import {
  describeBridgeFailure,
  formatBridgeStateDiagnostic,
  type BridgeFailureOrigin,
} from "./diagnostics.js";
import { createCodexProviderKeyGate, parseBlockedCodexProviderIds } from "./provider-key-gate.js";
import { ensureDefaultCodexConfigFiles } from "./default-codex-config.js";

// 此闭合方法表与 Host 侧 codexBridgeTitleDiagnostic.ts 同步；未知方法不输出原文。
const observedFrameMethods = new Set([
  "initialize",
  "thread/read",
  "thread/resume",
  "thread/turns/list",
  "thread/items/list",
  "thread/list",
  "thread/queue/list",
  "unknown",
]);

async function main(): Promise<void> {
  if (process.argv[2] === CODEZ_NATIVE_BROWSER_CUA_MCP_ENTRY_MODE) {
    await runNativeBrowserCuaMcp();
    return;
  }
  // 首次安装打开软件时自动补齐缺失的 config.toml 与模型目录文件，确保后续 GUI 可管理供应商与模型。
  await ensureDefaultCodexConfigFiles(process.env);
  // Windows 的 cwd 可保留 junction/短路径拼写；执行路径统一为物理目录，身份仍由 Host 指定。
  const cwd = await realpath(process.cwd());
  const workspaceId = process.env.CODEZ_WORKSPACE_IDENTITY?.trim() || cwd;
  const scope = createHash("sha256").update(workspaceId).digest("hex");
  const bridgeHome =
    process.env.CODEZ_CODEX_BRIDGE_HOME || join(homedir(), ".codez-codex", "bridge");
  const stateRoot = join(bridgeHome, scope);
  const rpc = createCodexProcess({
    executable: process.env.CODEZ_CODEX_COMMAND?.trim() || "codex",
    cwd,
    // Host 按设置页“显示待办”开关注入；update_plan 注册于原生配置加载期，进程内不可热切换。
    updatePlanToolEnabled: process.env[CODEZ_CODEX_UPDATE_PLAN_ENABLED_ENV_KEY]?.trim() === "1",
    desktopContextPromptEnabled:
      process.env[CODEZ_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]?.trim() === "1",
    desktopMcpServers: process.env[CODEZ_DESKTOP_MCP_SERVERS_ENV_KEY]
      ? desktopCodexMcpServersSchema.parse(
          JSON.parse(process.env[CODEZ_DESKTOP_MCP_SERVERS_ENV_KEY]),
        )
      : [],
    onFrameDropped: (frame) => {
      // 原因：过去此 stderr 落在远端 debug 日志，导出只能看到 LIMIT，无法确认
      // 是 resume 还是 history 页。只输出闭合分类与下界，不记录原生正文或路径。
      const method = observedFrameMethods.has(frame.method) ? frame.method : "unknown";
      process.stderr.write(
        `Codex desktop bridge warn: oversized native frame; kind=${frame.kind}; method=${method}; observedBytes=${frame.observedBytes}\n`,
      );
    },
    onRequestTimeout: ({ method, durationMs, pendingCount }) => {
      // 原因：原生 RPC 30s 超时过去只返回统一报错文案，导出日志无法定位是哪条原生方法卡死。
      // 这里只输出闭合格式的方法名、超时阈值与在途请求数，不记录任何参数或路径。
      const safeMethod = /^[A-Za-z0-9_/-]{1,64}$/.test(method) ? method : "unknown";
      process.stderr.write(
        `Codex desktop bridge warn: native rpc timed out; method=${safeMethod}; durationMs=${durationMs}; pending=${pendingCount}\n`,
      );
    },
    onStderrSummary: (summary) => {
      if (summary.lineCount === 0) return;
      // 原因：原生 stderr 可能含用户正文/凭据；这里只输出闭合计数、级别、target 与类别。
      process.stderr.write(
        `Codex desktop bridge warn: native stderr summary; exitCode=${summary.exitCode}; signal=${summary.signal}; lineCount=${summary.lineCount}; byteCount=${summary.byteCount}; truncated=${summary.truncated}; level=${summary.level}; target=${summary.target ?? "none"}; categories=${summary.categories.join(",") || "none"}\n`,
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
  // 本机临时 Key 门禁：Host 在 spawn 时注入缺凭据的供应商 id；缺省为空集即全部放行。
  const providerKeyGate = createCodexProviderKeyGate({
    rpc,
    blockedProviderIds: parseBlockedCodexProviderIds(),
  });
  runtime = new BridgeRuntime({
    rpc,
    cwd,
    workspaceId,
    stateRoot,
    officialMarketplaceRoot: join(bridgeHome, "official-codex-marketplace"),
    notify: (method, params) => write({ method, params }),
    logRuntimeNotice: (notice) => {
      // 只输出 Host 白名单可解析的 JSON 诊断；配置路径不会进入该记录。
      process.stderr.write(
        `Codex desktop bridge warn: runtime notice; payload=${JSON.stringify(notice)}\n`,
      );
    },
    logStateDiagnostic: (diagnostic) =>
      process.stderr.write(formatBridgeStateDiagnostic(diagnostic)),
    fatal,
    nativeBrowserCua: parseNativeBrowserCuaFacts(),
    providerKeyGate,
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
          // 配置写入成功后门禁的默认供应商缓存必须失效；多窗口/外部写入由
          // Host 侧轮换屏障重启进程兜底（新进程重新读取）。
          if (message.method === "config/batchWrite" || message.method === "config/value/write") {
            providerKeyGate.invalidateConfig();
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
