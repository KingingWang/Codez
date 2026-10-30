import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

/** 慢流屏障而非固定 sleep：真实 child 请求已到达后才能执行停止。 */
export function createSubagentStopModel() {
  let seq = 0;
  const held = [];
  const requests = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const lastUser = (body.input ?? []).filter((item) => item.role === "user").at(-1);
      const text = JSON.stringify(lastUser);
      const id = ++seq;
      const response = {
        id: `resp_${id}`,
        object: "response",
        status: "in_progress",
        output: [],
      };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const event = (type, fields) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      event("response.created", { response });
      const outputs = (body.input ?? []).filter((item) => item.type === "function_call_output");
      if (text.includes("E2E_CSSTOP32_CHILD") || (text.includes("CASCADE") && outputs.length > 0)) {
        const entry = { child: text.includes("E2E_CSSTOP32_CHILD"), closed: false };
        held.push(entry);
        res.once("close", () => {
          entry.closed = true;
        });
        return;
      }
      const root = text.includes("E2E_CSSTOP32_ROOT");
      const tools = (body.tools ?? []).flatMap((tool) =>
        tool.type === "namespace"
          ? (tool.tools ?? []).map((child) => ({ ...child, namespace: tool.name }))
          : [tool],
      );
      const spawnTool = tools.find(
        (tool) => tool.name === "spawn_agent" || tool.name?.endsWith("__spawn_agent"),
      );
      let output;
      if (root && outputs.length === 0) {
        assert.ok(spawnTool, "native provider must advertise spawn_agent");
        const count = text.includes("CASCADE") ? 2 : 1;
        output = Array.from({ length: count }, (_, index) => ({
          id: `spawn_${id}_${index}`,
          type: "function_call",
          status: "completed",
          call_id: `spawn_${id}_${index}`,
          name: spawnTool.name,
          ...(spawnTool.namespace ? { namespace: spawnTool.namespace } : {}),
          arguments: JSON.stringify({
            message: `E2E_CSSTOP32_CHILD_${id}_${index}`,
            ...(spawnTool.parameters?.properties?.task_name
              ? { task_name: `fixture_${index}` }
              : {}),
            ...(spawnTool.parameters?.properties?.fork_turns ? { fork_turns: "none" } : {}),
          }),
        }));
      } else {
        output = [
          {
            id: `msg_${id}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Synthetic parent settled", annotations: [] }],
          },
        ];
      }
      output.forEach((item, output_index) =>
        event("response.output_item.done", { output_index, item }),
      );
      event("response.completed", {
        response: {
          ...response,
          status: "completed",
          output,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      res.end();
    } catch (error) {
      errors.push(error);
      res.destroy(error);
    }
  });
  return { server, held, requests, errors };
}

export function startSubagentStopBridge({ bridge, binary, workspace, codexHome, stateRoot }) {
  const env = {
    CODEX_HOME: codexHome,
    CODEZ_CODEX_COMMAND: binary,
    CODEZ_CODEX_BRIDGE_HOME: stateRoot,
    CODEZ_WORKSPACE_IDENTITY: workspace,
  };
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ])
    if (process.env[key]) env[key] = process.env[key];
  const child = spawn(process.execPath, [bridge], { cwd: workspace, env, stdio: "pipe" });
  const closed = once(child, "close");
  closed.catch(() => {});
  const pending = new Map();
  const frames = [];
  let stderr = "";
  let id = 0;
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8192);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    if (value.method) frames.push(value);
    const entry = pending.get(value.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(value.id);
    if (value.error) entry.reject(new Error(JSON.stringify(value.error)));
    else entry.resolve(value.result);
  });
  child.on("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Bridge exited: ${stderr}`));
    }
    pending.clear();
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const nextId = ++id;
      const timer = setTimeout(() => {
        pending.delete(nextId);
        reject(new Error(`Timed out: ${method}; ${stderr}`));
      }, 20_000);
      pending.set(nextId, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id: nextId, method, params })}\n`);
    });
  return {
    rpc,
    frames,
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      const [code, signal] = await closed;
      assert.equal(code, 0, `Bridge shutdown signal=${signal}; ${stderr}`);
    },
  };
}
