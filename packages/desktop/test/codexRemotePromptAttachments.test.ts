import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { CodezPromptAttachment } from "@codez/shared";
import type { IRemoteBackend, StdioStream } from "@codez/server/remote";
import {
  cleanupRemotePromptAttachment,
  cleanupStaleRemotePromptAttachments,
  materializeRemotePromptAttachments,
} from "../src/host/remotePromptAttachments.js";

const REMOTE_HOME = "/home/tester";

function stream(stdoutText = "", exitCode = 0): StdioStream {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    stdin: new PassThrough(),
    stdout,
    stderr,
    onClose(listener) {
      queueMicrotask(() => {
        stdout.end(stdoutText);
        stderr.end();
        listener(exitCode);
      });
      return { dispose() {} };
    },
  };
}

function fixture() {
  const commands: string[] = [];
  const uploads: Array<{ localPath: string; remotePath: string }> = [];
  const backend: Pick<IRemoteBackend, "exec" | "upload"> = {
    async exec(command: string) {
      commands.push(command);
      return stream(command === 'printf %s "$HOME"' ? REMOTE_HOME : "");
    },
    async upload(localPath: string, remotePath: string) {
      uploads.push({ localPath, remotePath });
    },
  };
  return { backend, commands, uploads };
}

function attachment(localPath: string): CodezPromptAttachment {
  return { kind: "file", filename: "note.txt", localPath } as CodezPromptAttachment;
}

async function withRuntime<T>(value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.CODEZ_DESKTOP_RUNTIME;
  process.env.CODEZ_DESKTOP_RUNTIME = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.CODEZ_DESKTOP_RUNTIME;
    } else {
      process.env.CODEZ_DESKTOP_RUNTIME = previous;
    }
  }
}

function materialize(backend: Pick<IRemoteBackend, "exec" | "upload">, localPath: string) {
  return materializeRemotePromptAttachments(
    {
      content: `see ${localPath}`,
      traceId: "trace-1",
      attachments: [attachment(localPath)],
    },
    { backend },
  );
}

test("attachments stage under the codex flavor root", async () => {
  await withRuntime("codex", async () => {
    const f = fixture();
    const result = await materialize(f.backend, "/local/note.txt");
    assert.equal(result.uploadedCount, 1);
    const uploaded = f.uploads[0];
    assert.ok(uploaded);
    assert.ok(
      uploaded.remotePath.startsWith(`${REMOTE_HOME}/.codez-codex/tmp/prompt-attachments/`),
      uploaded.remotePath,
    );
    assert.ok(!result.content.includes("/local/note.txt"));
  });
});

test("explicit legacy runtime keeps the legacy root", async () => {
  await withRuntime("legacy", async () => {
    const f = fixture();
    const result = await materialize(f.backend, "/local/note.txt");
    assert.equal(result.uploadedCount, 1);
    const uploaded = f.uploads[0];
    assert.ok(uploaded);
    assert.ok(
      uploaded.remotePath.startsWith(`${REMOTE_HOME}/.codez/tmp/prompt-attachments/`),
      uploaded.remotePath,
    );
    assert.ok(!uploaded.remotePath.includes(".codez-codex"));
  });
});

test("old-root refs stay recognized under the codex flavor", async () => {
  await withRuntime("codex", async () => {
    const f = fixture();
    for (const ref of [
      `${REMOTE_HOME}/.codez/tmp/prompt-attachments/t/n/01-note.txt`,
      "~/.codez/tmp/prompt-attachments/t/n/01-note.txt",
      `${REMOTE_HOME}/.codez-codex/tmp/prompt-attachments/t/n/01-note.txt`,
      "~/.codez-codex/tmp/prompt-attachments/t/n/01-note.txt",
    ]) {
      const result = await materialize(f.backend, ref);
      assert.equal(result.uploadedCount, 0, ref);
      assert.equal(result.attachments?.[0]?.localPath, ref);
      assert.ok(result.content.includes(ref));
    }
    assert.deepEqual(f.uploads, []);
  });
});

test("single-file cleanup accepts both flavor roots and rejects foreign paths", async () => {
  await withRuntime("codex", async () => {
    const f = fixture();
    const oldRef = `${REMOTE_HOME}/.codez/tmp/prompt-attachments/t/n/01-note.txt`;
    const newRef = `${REMOTE_HOME}/.codez-codex/tmp/prompt-attachments/t/n/01-note.txt`;
    await cleanupRemotePromptAttachment(f.backend, oldRef);
    await cleanupRemotePromptAttachment(f.backend, newRef);
    assert.ok(f.commands.some((command) => command.includes(`rm -f '${oldRef}'`)));
    assert.ok(f.commands.some((command) => command.includes(`rm -f '${newRef}'`)));

    const before = f.commands.length;
    await cleanupRemotePromptAttachment(f.backend, "/etc/passwd");
    // 拒绝域外路径：只允许附件私有根下的清理，HOME 探测之外的命令不得出现。
    assert.equal(f.commands.length, before + 1);
    assert.ok(f.commands.every((command) => !command.includes("rm -f /etc/passwd")));
  });
});

test("stale sweep cleans the current root and the pre-isolation legacy root", async () => {
  await withRuntime("codex", async () => {
    const f = fixture();
    await cleanupStaleRemotePromptAttachments(f.backend, 60);
    const sweep = f.commands.find((command) => command.includes("-delete"));
    assert.ok(sweep);
    assert.ok(sweep.includes(`${REMOTE_HOME}/.codez-codex/tmp/prompt-attachments`));
    assert.ok(sweep.includes(`${REMOTE_HOME}/.codez/tmp/prompt-attachments`));
  });
  await withRuntime("legacy", async () => {
    const f = fixture();
    await cleanupStaleRemotePromptAttachments(f.backend, 60);
    const sweep = f.commands.find((command) => command.includes("-delete"));
    assert.ok(sweep);
    assert.ok(sweep.includes(`${REMOTE_HOME}/.codez/tmp/prompt-attachments`));
    assert.ok(!sweep.includes(".codez-codex"));
  });
});
