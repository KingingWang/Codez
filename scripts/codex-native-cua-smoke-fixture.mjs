import { createServer } from "node:http";

export function createNativeCuaModelServer(onRequest, namespace) {
  const targets = [7, [40, 60]];
  let requestCount = 0;
  return createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.once("end", () => {
      requestCount += 1;
      onRequest(JSON.parse(body));
      const target = targets.shift();
      const output =
        target === undefined
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
              call_id: Array.isArray(target) ? "array" : "numeric",
              name: "cua_command",
              namespace,
              // 只对整个 arguments 对象编码；target 的数字/数组类型不能被单独字符串化。
              arguments: JSON.stringify({ method: "left_click", target }),
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
