import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stageCodexBinary } from "./codex-runtime.mjs";

test(
  "verified native Codex discovers and resumes external project history",
  // 内层原生测试预算放宽到 120s 后，外层 wrapper 同步放宽到 180s。
  { timeout: 180000 },
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
        // 内层测试自身 120s 预算；外层留 150s 保证先拿到内层的失败详情而不是被腰斩。
        timeout: 150000,
      },
    );
    const [code, signal] = await once(child, "close");
    assert.equal(code, 0, `Native discovery regression failed (signal=${signal ?? "none"})`);
  },
);
