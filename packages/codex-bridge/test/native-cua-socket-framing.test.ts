import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Socket } from "node:net";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { callNativeCuaBroker, parseNativeCuaBrokerCredentials } from "../src/native-cua-mcp.js";
import { createNativeBrowserCuaMcpRuntime } from "../src/native-browser-cua-mcp.js";

/**
 * 回归：broker 响应跨 socket chunk 边界时的 UTF-8 解码完整性与帧定界。
 *
 * 原因：`native-cua-mcp.ts` 与 `native-browser-cua-mcp.ts` 过去都对每个 chunk 单独
 * `chunk.toString("utf8")` 再拼接，落在多字节字符中间的切点会被解码成 U+FFFD；
 * U+FFFD 在 JSON 字符串里是合法字符，`JSON.parse` 不会报错，于是乱码静默进入页面标题、
 * 无障碍树文本与错误信息，并作为工具结果交给模型。中文产品下 broker 响应几乎必含多字节字符，
 * 而截图/快照响应又天然是多 chunk 的，因此这是常态而非边界情况。
 *
 * 依据：ASCII 换行 0x0A 不可能出现在 UTF-8 多字节序列内部（续字节 0x80-0xBF、首字节 0xC0 以上），
 * 所以「按字节累积 + 只在新 chunk 内找 0x0A + 整帧一次性解码」与旧的字符串定界完全等价，
 * 且任何字符都不会跨边界解码。
 */

const CJK = "笔记窗口标题中文内容页面正文无障碍树";
const CJK_BYTES = Buffer.from(CJK, "utf8");

test("fixture sanity: a cut inside a multi-byte character really does decode to U+FFFD", () => {
  // 先证明这些切点是有意义的：3 字节汉字只取 1 字节时，逐 chunk 解码必然产生 U+FFFD。
  assert.equal(CJK_BYTES.length, CJK.length * 3);
  assert.ok(CJK_BYTES.subarray(0, 1).toString("utf8").includes("\uFFFD"));
  assert.ok(CJK_BYTES.subarray(0, 2).toString("utf8").includes("\uFFFD"));
  assert.equal(CJK_BYTES.subarray(0, 3).toString("utf8"), CJK[0]);
});

function brokerResponse(id: string): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      id,
      ok: true,
      result: {
        content: [{ type: "text", text: JSON.stringify({ state_id: "st-1", text: CJK }) }],
        structuredContent: { state_id: "st-1", text: CJK },
      },
    })}\n`,
    "utf8",
  );
}

/**
 * 造一个假 broker socket：按请求 id 组出真实响应，再在给定的若干「CJK 区内字节偏移」处切开，
 * 分成多个 data 事件投递。偏移相对于 CJK 区起点计算，因此与 id 长度无关。
 */
function splitSocketFactory(cutOffsets: readonly number[]): () => Socket {
  return () => {
    class FakeSocket extends EventEmitter {
      destroy(): void {}
      write(data: string): boolean {
        const frame = JSON.parse(data.trim()) as { id: string };
        const full = brokerResponse(frame.id);
        const cjkStart = full.indexOf(CJK_BYTES);
        assert.ok(cjkStart > 0, "fixture response must contain the CJK region");
        const cuts = [...cutOffsets.map((offset) => cjkStart + offset), full.length]
          .filter((cut) => cut > 0 && cut < full.length)
          .sort((left, right) => left - right);
        queueMicrotask(() => {
          let previous = 0;
          for (const cut of [...cuts, full.length]) {
            if (cut <= previous) continue;
            this.emit("data", full.subarray(previous, cut));
            previous = cut;
          }
        });
        return true;
      }
    }
    const socket = new FakeSocket();
    queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as Socket;
  };
}

async function callBrokerWithCuts(cutOffsets: readonly number[]): Promise<{
  structuredContent: { state_id: string; text: string };
}> {
  const active = new Set<Socket>();
  const result = await callNativeCuaBroker({
    cuaBroker: { socketPath: "/fixture/cua-broker.sock", capability: "cap", generation: 1 },
    signal: new AbortController().signal,
    method: "execute",
    params: { method: "get_app_state", input: {} },
    timeoutMs: 5_000,
    active,
    connect: splitSocketFactory(cutOffsets),
  });
  assert.equal(active.size, 0, "socket 必须已从 active 集合摘除");
  return result as { structuredContent: { state_id: string; text: string } };
}

test("CUA broker frame split at every byte offset inside a CJK region decodes without corruption", async () => {
  // 逐个字节偏移切一刀：覆盖「切在第 1/2/3 字节」的全部情形（3 字节汉字 → 54 个偏移）。
  for (let offset = 0; offset < CJK_BYTES.length; offset += 1) {
    const result = await callBrokerWithCuts([offset]);
    assert.equal(result.structuredContent.text, CJK, `CJK byte offset ${offset}`);
    assert.equal(result.structuredContent.state_id, "st-1", `CJK byte offset ${offset}`);
    assert.ok(
      !JSON.stringify(result).includes("\uFFFD"),
      `offset ${offset} 不得出现 U+FFFD 替换字符`,
    );
  }
});

test("CUA broker frame cut across several multi-byte characters at once stays intact", async () => {
  // 真实 socket 会把一帧切成多段：多点切割，且每个切点都落在字符内部。
  for (const cuts of [
    [1, 2],
    [1, 5, 9, 17],
    [2, 3, 4, 7, 11, 13, 29, 33, 53],
    [0, 1, CJK_BYTES.length - 1],
  ]) {
    const result = await callBrokerWithCuts(cuts);
    assert.equal(result.structuredContent.text, CJK, `cuts ${cuts.join(",")}`);
    assert.ok(!JSON.stringify(result).includes("\uFFFD"), `cuts ${cuts.join(",")}`);
  }
});

test("an undivided CUA broker frame still parses identically", async () => {
  // 单 chunk 是常见情形，必须与切割路径给出完全一致的结果。
  const single = await callBrokerWithCuts([]);
  const split = await callBrokerWithCuts([7, 23]);
  assert.deepEqual(split, single);
  assert.equal(single.structuredContent.text, CJK);
});

test("native browser/CUA carrier keeps CJK intact when the broker frame spans socket chunks", async () => {
  // 同一处缺陷在 native-browser-cua-mcp.ts 里是独立实现，必须各自钉住。
  const cuaBroker = parseNativeCuaBrokerCredentials({
    CODEZ_CUA_PERMISSION_BROKER_SOCKET: "/fixture/cua-broker.sock",
    CODEZ_CUA_PLUGIN_AUTHORITY: "local-cua-authority",
    CODEZ_CUA_PERMISSION_BROKER_GENERATION: "3",
  });
  for (const offset of [1, 2, 5, 17, 33, 53]) {
    const runtime = createNativeBrowserCuaMcpRuntime({
      endpoint: "/fixture/native-browser.sock",
      tokenFile: "/fixture/native-browser.token",
      cuaBroker,
      readFile: async () => "fixture-token",
      connect: (endpoint) => {
        assert.equal(endpoint, "/fixture/cua-broker.sock");
        return splitSocketFactory([offset])();
      },
      browserEnabled: true,
      cuaEnabled: true,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fixture", version: "0" });
    await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "cua_command",
        arguments: { method: "get_app_state", app_ref: { name: "Notes" } },
      });
      assert.notEqual(result.isError, true, `offset ${offset} 不应失败`);
      const blocks = result.content as Array<{ type: string; text?: string }>;
      const text = blocks.find((block) => block.type === "text")?.text ?? "";
      assert.equal(JSON.parse(text).text as string, CJK, `offset ${offset}`);
      assert.ok(!text.includes("\uFFFD"), `offset ${offset} 不得出现 U+FFFD`);
    } finally {
      await Promise.allSettled([client.close(), runtime.server.close()]);
      runtime.dispose();
    }
  }
});
