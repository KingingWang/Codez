import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createCuaProductMcpServerResolver,
  type ManagedCuaProductHelperHost,
} from "@codez/codez-cua/broker/server";
import {
  attachCuaCredentialGrantPublisher,
  createCuaCredentialGrantPublisher,
  resolveCuaCredentialGrantRootDirectory,
} from "./cuaCredentialGrantPublisher.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

const validHandle = {
  socketPath: "\\\\.\\pipe\\codez-cua",
  pluginAuthority: "capability-secret",
  generation: 9,
};

test("publishes the complete authenticated tuple only after the exact start settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-cua-grant-"));
  const publisher = await createCuaCredentialGrantPublisher({
    grantRootDirectory: resolveCuaCredentialGrantRootDirectory(root),
  });
  const gate = deferred<typeof validHandle>();
  const publication = publisher.publish(gate.promise);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(stat(publisher.grantFilePath), /ENOENT/u);
  gate.resolve(validHandle);
  await publication;
  assert.deepEqual(JSON.parse(await readFile(publisher.grantFilePath, "utf8")), {
    socketPath: validHandle.socketPath,
    capability: validHandle.pluginAuthority,
    generation: validHandle.generation,
  });
  // Windows ACL 语义不同；这里只验证 POSIX mode，产品侧 ACL 由宿主目录边界保证。
  if (process.platform !== "win32") {
    assert.equal((await stat(publisher.grantFilePath)).mode & 0o777, 0o600);
  }
  await publisher.dispose();
  await assert.rejects(stat(publisher.grantFilePath), /ENOENT/u);
  await rm(root, { recursive: true, force: true });
});

test("dispose fences a pending startup and returns before that startup resolves", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-cua-grant-dispose-"));
  const publisher = await createCuaCredentialGrantPublisher({
    grantRootDirectory: resolveCuaCredentialGrantRootDirectory(root),
  });
  const gate = deferred<typeof validHandle>();
  const publication = publisher.publish(gate.promise);
  const startedAt = Date.now();
  await publisher.dispose();
  assert.ok(Date.now() - startedAt < 500);
  gate.resolve(validHandle);
  await publication;
  await assert.rejects(stat(publisher.grantFilePath), /ENOENT/u);
  await rm(root, { recursive: true, force: true });
});

test("per-owner directories prevent replacement or cross-revocation between hosts", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-cua-grant-owners-"));
  const grantRoot = resolveCuaCredentialGrantRootDirectory(root);
  const first = await createCuaCredentialGrantPublisher({ grantRootDirectory: grantRoot });
  const second = await createCuaCredentialGrantPublisher({ grantRootDirectory: grantRoot });
  assert.notEqual(first.grantFilePath, second.grantFilePath);
  await first.publish(Promise.resolve({ ...validHandle, capability: "first-secret" }));
  await second.publish(Promise.resolve({ ...validHandle, pluginAuthority: "second-secret" }));
  await first.dispose();
  assert.deepEqual(JSON.parse(await readFile(second.grantFilePath, "utf8")), {
    socketPath: validHandle.socketPath,
    capability: "second-secret",
    generation: validHandle.generation,
  });
  await second.dispose();
  await rm(root, { recursive: true, force: true });
});

test("invalid handles remove stale projections and leave no final grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-cua-grant-invalid-"));
  const publisher = await createCuaCredentialGrantPublisher({
    grantRootDirectory: resolveCuaCredentialGrantRootDirectory(root),
  });
  await publisher.publish(Promise.resolve(validHandle));
  await publisher.publish(Promise.resolve({ socketPath: "local", generation: 12 }));
  await assert.rejects(stat(publisher.grantFilePath), /ENOENT/u);
  const ownerFiles = await readdir(dirname(publisher.grantFilePath));
  assert.deepEqual(ownerFiles, []);
  await publisher.dispose();
  await rm(root, { recursive: true, force: true });
});

test("a stale failed start cannot remove a newer published grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-cua-grant-epoch-"));
  const publisher = await createCuaCredentialGrantPublisher({
    grantRootDirectory: resolveCuaCredentialGrantRootDirectory(root),
  });
  const olderFailure = deferred<typeof validHandle>();
  const olderPublication = publisher.publish(olderFailure.promise);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await publisher.publish(Promise.resolve(validHandle));
  olderFailure.reject(new Error("older helper startup failed"));
  await olderPublication;
  assert.deepEqual(JSON.parse(await readFile(publisher.grantFilePath, "utf8")), {
    socketPath: validHandle.socketPath,
    capability: validHandle.pluginAuthority,
    generation: validHandle.generation,
  });
  await publisher.dispose();
  await rm(root, { recursive: true, force: true });
});

test("every Host restart path revokes and republishes even without calling public start", async () => {
  const root = await mkdtemp(join(tmpdir(), "codez-grant-restart-"));
  const publisher = await createCuaCredentialGrantPublisher({ grantRootDirectory: root });
  let next = deferred<typeof validHandle>();
  let starts = 0;
  let reused = false;
  let failSynchronously = false;
  const host: ManagedCuaProductHelperHost = {
    running: true,
    socketPath: validHandle.socketPath,
    pluginAuthority: validHandle.pluginAuthority,
    async start() {
      starts += 1;
      return validHandle;
    },
    async stop() {},
    restart() {
      if (failSynchronously) throw new Error("sync restart failed");
      return next.promise;
    },
    restartAfterCurrentStart: () => next.promise,
    restartAfterCurrentStartPreservingTransport: async () => ({
      handle: await next.promise,
      reused,
    }),
    async checkHealth() {
      return { bundleId: "dev.codez.cua-helper", pid: 1 };
    },
  };
  const resolver = createCuaProductMcpServerResolver(host);
  attachCuaCredentialGrantPublisher(host, publisher);
  try {
    await host.start();
    let generation = 10;
    let currentHandle = validHandle;
    for (const entry of [
      { restart: () => host.restart(), reused: false },
      { restart: () => host.restartAfterCurrentStart(), reused: false },
      { restart: () => host.restartAfterCurrentStartPreservingTransport!(), reused: false },
      { restart: () => host.restartAfterCurrentStartPreservingTransport!(), reused: true },
      { restart: () => resolver.restart(), reused: false },
    ]) {
      reused = entry.reused;
      next = deferred();
      const pending = entry.restart();
      const deadline = Date.now() + 1_000;
      while (true) {
        const exists = await stat(publisher.grantFilePath).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (!exists) break;
        assert.ok(
          Date.now() < deadline,
          "restart admission must revoke the old grant before ready",
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const ready = reused
        ? currentHandle
        : { ...validHandle, socketPath: `pipe-${generation}`, generation: generation++ };
      next.resolve(ready);
      await pending;
      assert.deepEqual(JSON.parse(await readFile(publisher.grantFilePath, "utf8")), {
        socketPath: ready.socketPath,
        capability: ready.pluginAuthority,
        generation: ready.generation,
      });
      currentHandle = ready;
    }
    assert.equal(starts, 1, "restart fixtures must bypass public start");
    next = deferred();
    const failed = host.restart();
    next.reject(new Error("restart failed"));
    await assert.rejects(failed, /restart failed/u);
    await assert.rejects(stat(publisher.grantFilePath), /ENOENT/u);
    await host.start();
    failSynchronously = true;
    await assert.rejects(host.restart(), /sync restart failed/u);
    await assert.rejects(stat(publisher.grantFilePath), /ENOENT/u);
  } finally {
    await publisher.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
