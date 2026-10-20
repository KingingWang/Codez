import assert from "node:assert/strict";
import test from "node:test";
import { codexNativeHostFromHello } from "./useCodexNativeHost.js";

function hello(capabilities: unknown): { capabilities?: unknown } {
  return capabilities === undefined ? {} : { capabilities };
}

test("codex native host requires the bridge capability projection", () => {
  // fail-closed：hello 缺失 capabilities、旧 peer 缺省 codex 面、显式
  // codexUnavailable 都不得开启远控链路的排队/引导选择器。
  assert.equal(codexNativeHostFromHello(hello(undefined)), false);
  assert.equal(codexNativeHostFromHello(hello({})), false);
  assert.equal(
    codexNativeHostFromHello(hello({ codexUnavailable: { reason: "bridge-unavailable" } })),
    false,
  );
  assert.equal(
    codexNativeHostFromHello(
      hello({ codexUnavailable: { reason: "bridge-unavailable" }, codex: {} }),
    ),
    false,
  );
  // bridge 在场：能力面出现即原生会话（具体功能仍由各自能力位门控）。
  assert.equal(codexNativeHostFromHello(hello({ codex: {} })), true);
  assert.equal(
    codexNativeHostFromHello(hello({ codex: { messageFeedback: "unsupported" } })),
    true,
  );
});
