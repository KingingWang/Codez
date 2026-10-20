import { createServer } from "node:http";

export function createNativeCuaModelServer(onRequest, namespace, calls = []) {
  const callQueue = [...calls];
  let requestCount = 0;
  return createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.once("end", () => {
      requestCount += 1;
      const parsed = JSON.parse(body);
      onRequest(parsed);
      const call = callQueue.shift();
      // codex-20261020 起，namespace-incapable provider（如本 smoke 的 fake provider）
      // 会把命名空间工具扁平化为 `namespace__name` 并归入默认 namespace，调用路由
      // 只认扁平名；旧版仍保留 namespace 包装。真实模型只会回拨声明过的名字，
      // 因此按本请求实际声明的形式回拨，使 fixture 与两种 release 都兼容。
      const declared = Array.isArray(parsed?.tools) ? parsed.tools : [];
      const flatName = call ? `${namespace}__${call.name}` : "";
      const useFlat = call !== undefined && declared.some((tool) => tool?.name === flatName);
      const output =
        call === undefined
          ? {
              id: "final",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "native cua smoke complete", annotations: [] },
              ],
            }
          : {
              id: `item_${requestCount}`,
              type: "function_call",
              status: "completed",
              call_id: `call_${requestCount}`,
              name: useFlat ? flatName : call.name,
              ...(useFlat ? {} : { namespace }),
              // 只对整个 arguments 对象编码，避免调用方或客户端改写字段 JSON 类型。
              arguments: JSON.stringify(call.arguments),
            };
      const completed = {
        id: `response_${requestCount}`,
        object: "response",
        status: "completed",
        output: [output],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };
      const events = [
        { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item: output },
        { type: "response.completed", response: completed },
      ];
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      );
    });
  });
}
