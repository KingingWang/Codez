import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const rejectClose of [false, true])
  test(
    `production bridge emits a safe fatal diagnostic and exits without retry (reject close: ${rejectClose})`,
    {
      timeout: 15_000,
      skip: process.platform === "win32", // Existing fake executable uses a POSIX shebang.
    },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "zcode-fatal-diagnostic-"));
      const executable = join(directory, "fake-codex");
      await copyFile(new URL("./fixtures/fake-codex.mjs", import.meta.url), executable);
      await chmod(executable, 0o700);
      const child = spawn(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          ...(rejectClose
            ? ["--import", new URL("./fixtures/reject-runtime-close.mjs", import.meta.url).href]
            : []),
          fileURLToPath(new URL("../src/main.ts", import.meta.url)),
        ],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            CODEX_HOME: directory,
            ZCODE_CODEX_COMMAND: executable,
            ZCODE_CODEX_BRIDGE_HOME: join(directory, "bridge"),
            FAKE_CODEX_TRACE: join(directory, "trace"),
          },
          stdio: "pipe",
          timeout: 10_000,
        },
      );
      const closed = once(child, "close");
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const lines = createInterface({ input: child.stdout });
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
        lines.close();
        await rm(directory, { recursive: true, force: true });
      });
      const ready = once(lines, "line");
      child.stdin.write(
        `${JSON.stringify({ id: 1, method: "codex/request", params: { method: "account/read" } })}\n`,
      );
      // A response (including the fixture's unsupported-method error) proves initialization finished.
      await ready;
      child.stdin.end("synthetic-secret /Users/private prompt-content\n");
      const [code] = await closed;
      assert.equal(code, 1);
      assert.match(stderr, /"category":"native-transport"/);
      assert.match(stderr, /"origin":"host-protocol"/);
      assert.match(stderr, /"code":"PROTOCOL"/);
      assert.match(stderr, /No request was retried/);
      if (rejectClose) assert.match(stderr, /"origin":"shutdown"/);
      assert.doesNotMatch(
        stderr,
        /synthetic-secret|Users|prompt-content|shutdown-content|Error:|at .*\.ts/,
      );
    },
  );
