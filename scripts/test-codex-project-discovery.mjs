import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stageCodexBinary } from "./codex-runtime.mjs";

test(
  "verified native Codex discovers and resumes external project history",
  { timeout: 90000 },
  async () => {
    const binary = await stageCodexBinary();
    // 普通单测可在下载前跳过原生测试；发布矩阵必须用当前平台已验证的二进制实际执行。
    const env = { ...process.env, CODEX_AUXILIARY_TEST_BINARY: binary };
    // 子 runner 必须独立运行；继承父 node:test 标记会让 Node 静默跳过全部测试。
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--test",
        fileURLToPath(
          new URL(
            "../packages/codex-bridge/test/project-discovery-native.test.ts",
            import.meta.url,
          ),
        ),
      ],
      {
        env,
        stdio: "inherit",
        timeout: 75000,
      },
    );
    const [code, signal] = await once(child, "close");
    assert.equal(code, 0, `Native discovery regression failed (signal=${signal ?? "none"})`);
  },
);
