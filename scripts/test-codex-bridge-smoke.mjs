import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { buildCodexBridge } from "./build-codex-bridge.mjs";
import { stageCodexBinary } from "./codex-runtime.mjs";
import { pixelPng, createSmokeModelServer } from "./codex-bridge-smoke-fixture.mjs";

test(
  "actual pinned Codex + bundled bridge: settings, thread, stream, queue, reconnect",
  { timeout: 120000 },
  async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "codez-bridge-smoke-"));
    const codexHome = join(temporary, "codex-home");
    const directory = join(temporary, "physical-workspace");
    const workspace = join(temporary, "workspace-alias");
    await mkdir(codexHome);
    await mkdir(directory);
    await symlink(directory, workspace, process.platform === "win32" ? "junction" : "dir");
    const { server, requests } = createSmokeModelServer({ reuseItemId: true });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    await writeFile(
      join(codexHome, "config.toml"),
      `model_provider = "smoke"\nmodel = "gpt-5.2"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.smoke]\nname = "Isolated test"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n`,
    );
    const binary = await stageCodexBinary();
    const bridge = await buildCodexBridge();
    const env = {
      CODEX_HOME: codexHome,
      CODEZ_CODEX_COMMAND: binary,
      CODEZ_CODEX_BRIDGE_TEST_DIAGNOSTICS: "1",
      CODEZ_CODEX_BRIDGE_HOME: join(temporary, "bridge-state"),
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
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    let child;
    let closeChild;
    const frames = [];
    const start = () => {
      child = spawn(process.execPath, [bridge], { cwd: workspace, env, stdio: "pipe" });
      closeChild = once(child, "close");
      closeChild.catch(() => {});
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));
      const pending = new Map();
      let nextId = 0;
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
      child.on("exit", () => {
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error("Bridge exited"));
        }
        pending.clear();
      });
      return (method, params) =>
        new Promise((resolve, reject) => {
          const id = ++nextId;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Timed out: ${method}`));
          }, 20000);
          pending.set(id, { resolve, reject, timer });
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        });
    };
    const stop = async () => {
      child.stdin.end();
      await closeChild;
    };
    let cleanupFailure;
    try {
      let rpc = start();
      const account = await rpc("codex/request", {
        method: "account/read",
        params: { refreshToken: false },
      });
      assert.equal(account.requiresOpenaiAuth, false);
      const generated = await rpc("workspace/generateText", {
        workspace: { workspacePath: workspace, workspaceKey: workspace },
        selection: { providerId: "smoke", modelId: "gpt-5.2" },
        prompt: "Generate a commit subject from this synthetic change",
        querySource: "git_commit_message",
        operationId: "auxiliary-1",
      });
      assert.equal(generated.text, "Bridge smoke response");
      const config = await rpc("v4/conversation/subscribe", {
        topic: `workspace-config/${workspace}`,
        connectionId: "desktop",
        clientMode: "desktop-continuous",
      });
      assert.equal(config.ack.mode, "snapshot");
      const created = await rpc("v4/command", {
        commandId: "create-1",
        clientId: "desktop",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: workspace },
        issuedAt: Date.now(),
      });
      assert.equal(created.status, "accepted", created.message);
      const sessionId = created.result.sessionId;
      await rpc("v4/conversation/subscribe", {
        topic: `conversation/${sessionId}`,
        connectionId: "desktop",
        clientMode: "desktop-continuous",
        workspace: {
          workspacePath: workspace,
          workspaceIdentity: workspace,
          workspaceKey: workspace,
        },
      });
      const image = pixelPng();
      const upload = { sessionId, connectionId: "desktop", uploadId: "image-1" };
      await rpc("v4/attachment/begin", {
        ...upload,
        fileName: "pixel.png",
        mime: "image/png",
        totalBytes: image.length,
        totalChunks: 1,
        checksum: `sha256:${createHash("sha256").update(image).digest("hex")}`,
      });
      await rpc("v4/attachment/chunk", {
        ...upload,
        chunkIndex: 0,
        dataBase64: image.toString("base64"),
      });
      const committed = await rpc("v4/attachment/commit", upload);
      const imageAttachment = {
        ref: committed.ref,
        fileName: "pixel.png",
        mime: "image/png",
        bytes: image.length,
      };
      const queued = await rpc("v4/command", {
        commandId: "queue-1",
        clientId: "desktop",
        sessionId,
        type: "sendText",
        payload: {
          text: "queued smoke",
          requestedDelivery: "queue",
          attachments: [imageAttachment],
        },
        issuedAt: Date.now(),
      });
      assert.equal(queued.status, "accepted", queued.message);
      // Native queues automatically dispatch when idle; they are not the legacy held queue.
      let rows;
      const completionDeadline = Date.now() + 20000;
      while (Date.now() < completionDeadline) {
        rows = await rpc("v4/conversation/rowsRange", { sessionId, limit: 200 });
        if (
          rows.rows.some(
            (row) =>
              row.kind === "assistantText" &&
              row.text === "Bridge smoke response" &&
              row.state === "complete",
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(
        rows.rows.some(
          (row) => row.kind === "assistantText" && row.text === "Bridge smoke response",
        ),
        "actual Codex response reaches V4 rows",
      );
      assert.ok(requests() > 0);
      const firstImage = await rpc("v4/command", {
        commandId: "start-image",
        clientId: "desktop",
        sessionId,
        type: "sendText",
        payload: {
          text: "Immediate image",
          attachments: [imageAttachment],
          requestedDelivery: "startNow",
        },
        issuedAt: Date.now(),
      });
      assert.equal(firstImage.status, "accepted", firstImage.message);
      const imageDeadline = Date.now() + 20000;
      let completedImages = false;
      while (Date.now() < imageDeadline) {
        const imageRows = await rpc("v4/conversation/rowsRange", { sessionId, limit: 200 });
        if (
          imageRows.rows.filter((row) => row.kind === "assistantText" && row.state === "complete")
            .length === 2
        ) {
          completedImages = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(
        completedImages,
        "turn/start image and its provisional localImage project before completion",
      );
      const twoTurnRows = await rpc("v4/conversation/rowsRange", { sessionId, limit: 200 });
      const completedAnswers = twoTurnRows.rows.filter(
        (row) =>
          row.kind === "assistantText" &&
          row.state === "complete" &&
          row.entityId?.endsWith(":item:msg_reused_across_turns"),
      );
      assert.equal(
        completedAnswers.length,
        2,
        "two real turns reuse the native message ID but keep turn-scoped entity IDs",
      );
      assert.equal(new Set(completedAnswers.map((row) => row.entityId)).size, 2);
      await stop();
      rpc = start();
      const resumed = await rpc("v4/conversation/subscribe", {
        topic: `conversation/${sessionId}`,
        connectionId: "mobile",
        clientMode: "web-remote-replayable",
        workspace: {
          workspacePath: workspace,
          workspaceIdentity: workspace,
          workspaceKey: workspace,
        },
      });
      assert.equal(resumed.ack.mode, "snapshot");
      const duplicate = await rpc("v4/command", {
        commandId: "queue-1",
        clientId: "desktop",
        sessionId,
        type: "sendText",
        payload: { text: "queued smoke", requestedDelivery: "queue" },
        issuedAt: Date.now(),
      });
      assert.deepEqual(duplicate, queued);
      const history = await rpc("v4/conversation/rowsRange", { sessionId, limit: 200 });
      assert.equal(
        history.rows.find((row) => row.kind === "userInput")?.attachments?.length,
        1,
        "image preview survives native history restoration",
      );
      assert.equal(
        history.rows.filter((row) => row.kind === "userInput" && row.sourceCommandId === "queue-1")
          .length,
        1,
      );
      assert.ok(
        history.rows.some(
          (row) => row.kind === "assistantText" && row.text === "Bridge smoke response",
        ),
      );
      const originalUser = history.rows.find((row) => row.kind === "userInput");
      const preview = await rpc("v4/attachment/read", {
        sessionId,
        ref: originalUser.attachments[0].ref,
        target: { rowId: originalUser.rowId, entityId: originalUser.entityId },
        attachmentIndex: 0,
        offset: 0,
        limit: 4096,
      });
      assert.equal(
        preview.dataBase64,
        image.toString("base64"),
        "restored row authorizes actual preview bytes",
      );
      await assert.rejects(
        rpc("v4/attachment/read", {
          sessionId,
          ref: originalUser.attachments[0].ref,
          target: { rowId: originalUser.rowId, entityId: "wrong-item" },
          attachmentIndex: 0,
          offset: 0,
          limit: 4096,
        }),
        /NotAuthorized/,
      );
      const edited = await rpc("v4/command", {
        commandId: "edit-1",
        clientId: "mobile",
        sessionId,
        type: "editUserQuery",
        baseRevision: history.atRevision,
        baseLogEpoch: history.atLogEpoch,
        payload: {
          target: { rowId: originalUser.rowId, entityId: originalUser.entityId },
          newText: "Edited smoke",
          workspaceMode: "preserve",
        },
        issuedAt: Date.now(),
      });
      assert.equal(edited.status, "accepted", edited.message);
      const editedHistory = await rpc("v4/conversation/rowsRange", { sessionId, limit: 200 });
      assert.notEqual(
        editedHistory.atLogEpoch,
        history.atLogEpoch,
        "history replacement rotates projection epoch",
      );
      const editedDeadline = Date.now() + 20000;
      while (Date.now() < editedDeadline) {
        const state = await rpc("v4/conversation/rowsRange", { sessionId, limit: 200 });
        if (state.rows.some((row) => row.kind === "assistantText" && row.state === "complete"))
          break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const deleted = await rpc("v4/command", {
        commandId: "delete-1",
        clientId: "mobile",
        sessionId,
        type: "deleteSession",
        payload: {},
        issuedAt: Date.now(),
      });
      assert.equal(deleted.status, "accepted", deleted.message);
      await assert.rejects(
        rpc("v4/attachment/read", {
          sessionId,
          ref: originalUser.attachments[0].ref,
          offset: 0,
          limit: 4096,
        }),
        /deleted/,
      );
      await stop();
    } catch (error) {
      t.diagnostic(`Native smoke failure before cleanup: ${error.stack ?? error}`);
      throw error;
    } finally {
      if (child?.exitCode === null && child.signalCode === null) {
        // Windows kill 会直接终止 bridge 而留下 native 子进程；EOF 让其先完成受控关闭。
        await stop();
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      try {
        await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) {
        cleanupFailure = error;
        t.diagnostic(`Isolated fixture cleanup also failed: ${error.code}`);
      }
    }
    if (cleanupFailure) throw cleanupFailure;
  },
);
