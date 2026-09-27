import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBrowserCuaMcpBroker } from "../src/main/browserView/nativeBrowserCuaMcpBroker.js";

function once<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

test("native broker authenticates and rejects invalid requests before manager", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-browser-cua-"));
  const executed: unknown[] = [];
  const broker = createNativeBrowserCuaMcpBroker({
    manager: {
      async execute(...args: unknown[]) {
        executed.push(args);
        return {
          ok: true,
          state: {
            url: "https://example.invalid",
            title: "Fixture",
            canGoBack: false,
            canGoForward: false,
          },
          elapsedMs: 0,
        };
      },
    } as never,
    flavor: "test",
    userDataPath: directory,
    temporaryDirectory: directory,
    eligibleWindowResolver: (windowId) => ({ id: windowId }) as never,
    logger: { warn: () => {} },
  });
  await broker.ready;
  await broker.registerWindow(1);
  const endpoint = broker.descriptor({
    executable: process.execPath,
    bridgePath: "/fixture/bridge.cjs",
    windowId: 1,
  }).endpoint;
  const tokenFile = join(directory, "codez-native-browser-cua-test-1.token");
  const token = (await readFile(tokenFile, "utf8")).trim();
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  const responses: string[] = [];
  const done = once();
  const invalid = connect(endpoint);
  invalid.on("error", done.reject);
  invalid.on("data", (chunk) => {
    responses.push(chunk.toString());
    done.resolve();
  });
  invalid.on("connect", () => invalid.write(`${JSON.stringify({ id: "not uuid", token })}\n`));
  await done.promise;
  invalid.destroy();
  assert.match(responses[0]!, /invalid_request/u);
  const authDone = once();
  const auth = connect(endpoint);
  const authResponses: string[] = [];
  auth.on("error", authDone.reject);
  auth.on("data", (chunk) => {
    authResponses.push(chunk.toString());
    authDone.resolve();
  });
  auth.on("connect", () =>
    auth.write(
      `${JSON.stringify({
        id: "00000000-0000-4000-8000-000000000001",
        token: "0".repeat(64),
        command: { method: "getState" },
      })}\n`,
    ),
  );
  await authDone.promise;
  auth.destroy();
  assert.match(authResponses[0]!, /authentication_failed/u);
  assert.deepEqual(executed, []);
  await broker.close();
  await rm(directory, { recursive: true, force: true });
});

test("native broker dispatches authorized commands and reports unavailable windows fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-browser-cua-"));
  const executed: string[] = [];
  let resolveWindow: (() => { id: number }) | null = () => ({ id: 1 });
  const broker = createNativeBrowserCuaMcpBroker({
    manager: {
      async execute() {
        executed.push("called");
        return {
          ok: true,
          state: {
            url: "https://example.invalid",
            title: "Fixture",
            canGoBack: false,
            canGoForward: false,
          },
          elapsedMs: 0,
        };
      },
    } as never,
    flavor: "test",
    userDataPath: directory,
    temporaryDirectory: directory,
    eligibleWindowResolver: (windowId) =>
      resolveWindow?.() && resolveWindow().id === windowId ? (resolveWindow() as never) : null,
    logger: { warn: () => {} },
  });
  await broker.readiness;
  await broker.registerWindow(1);
  const descriptor = broker.descriptor({
    executable: process.execPath,
    bridgePath: "/fixture/bridge.cjs",
    windowId: 1,
  });
  const token = (
    await readFile(join(directory, "codez-native-browser-cua-test-1.token"), "utf8")
  ).trim();
  resolveWindow = () => ({ id: 1 });
  const request = async (command: unknown, hasWindow = true) => {
    const done = once<string>();
    const socket = connect(descriptor.endpoint);
    socket.on("error", done.reject);
    socket.on("data", (chunk) => {
      socket.destroy();
      done.resolve(chunk.toString());
    });
    socket.on("connect", () => {
      resolveWindow = hasWindow ? () => ({ id: 1 }) : null;
      socket.write(
        `${JSON.stringify({
          id: "00000000-0000-4000-8000-000000000002",
          token,
          command,
        })}\n`,
      );
    });
    return await done.promise;
  };
  assert.match(await request({ method: "getState" }, false), /backend_unavailable/u);
  assert.deepEqual(executed, []);
  assert.match(await request({ method: "getState" }), /"ok":true/u);
  assert.deepEqual(executed, ["called"]);
  await broker.close();
  await rm(directory, { recursive: true, force: true });
});

test("native broker window token failure rejects registerWindow and fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-browser-cua-"));
  let rejectToken: ((error: unknown) => void) | undefined;
  const broker = createNativeBrowserCuaMcpBroker({
    manager: {
      async execute() {
        throw new Error("must not execute");
      },
    } as never,
    flavor: "test",
    userDataPath: directory,
    temporaryDirectory: directory,
    eligibleWindowResolver: () => null,
    logger: { warn: () => {} },
    tokenFileWriter: () =>
      new Promise((_resolve, reject) => {
        rejectToken = reject;
      }),
  });
  assert.equal(broker.availability.browserAvailable, false);
  await broker.ready;
  const registration = broker.registerWindow(1);
  await new Promise((resolve) => setImmediate(resolve));
  rejectToken(new Error("token write fixture failed"));
  await assert.rejects(registration, /token write fixture failed/u);
  assert.deepEqual(broker.availability, { browserAvailable: false, cuaAvailable: false });
  await broker.close();
  await rm(directory, { recursive: true, force: true });
});

test("native broker scopes tokens to exact windows and revokes only the owned credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-browser-cua-"));
  const executed: { windowId: number; browserId: string; workspaceKey: string }[] = [];
  const broker = createNativeBrowserCuaMcpBroker({
    manager: {
      async execute(owner) {
        executed.push({
          windowId: owner.windowId,
          browserId: owner.browserId,
          workspaceKey: owner.workspaceKey,
        });
        return {
          ok: true,
          state: {
            url: "https://example.invalid",
            title: "Fixture",
            canGoBack: false,
            canGoForward: false,
          },
          elapsedMs: 0,
        };
      },
    } as never,
    flavor: "test",
    userDataPath: directory,
    temporaryDirectory: directory,
    eligibleWindowResolver: (windowId) => ({ id: windowId }) as never,
    logger: { warn: () => {} },
  });
  await broker.readiness;
  await broker.registerWindow(1);
  await broker.registerWindow(2);
  const first = broker.descriptor({
    executable: process.execPath,
    bridgePath: "/fixture/bridge.cjs",
    windowId: 1,
  });
  const second = broker.descriptor({
    executable: process.execPath,
    bridgePath: "/fixture/bridge.cjs",
    windowId: 2,
  });
  assert.equal(first.endpoint, second.endpoint);
  assert.notEqual(first.tokenFile, second.tokenFile);
  const firstToken = (await readFile(first.tokenFile, "utf8")).trim();
  const secondToken = (await readFile(second.tokenFile, "utf8")).trim();
  assert.notEqual(firstToken, secondToken);
  assert.equal((await stat(first.tokenFile)).mode & 0o777, 0o600);
  assert.equal((await stat(second.tokenFile)).mode & 0o777, 0o600);
  const request = async (token: string, id: string) => {
    const done = once<string>();
    const socket = connect(first.endpoint);
    socket.on("error", done.reject);
    socket.on("data", (chunk) => {
      socket.destroy();
      done.resolve(chunk.toString());
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, token, command: { method: "getState" } })}\n`);
    });
    return await done.promise;
  };
  assert.match(await request(firstToken, "00000000-0000-4000-8000-000000000003"), /"ok":true/u);
  assert.match(await request(secondToken, "00000000-0000-4000-8000-000000000004"), /"ok":true/u);
  assert.deepEqual(executed, [
    {
      windowId: 1,
      browserId: "native-browser-cua:test-1",
      workspaceKey: "native-browser-cua:test-1",
    },
    {
      windowId: 2,
      browserId: "native-browser-cua:test-2",
      workspaceKey: "native-browser-cua:test-2",
    },
  ]);
  await broker.revokeWindow(1);
  await assert.rejects(stat(first.tokenFile), /ENOENT/u);
  assert.match(
    await request(firstToken, "00000000-0000-4000-8000-000000000005"),
    /authentication_failed/u,
  );
  assert.match(await request(secondToken, "00000000-0000-4000-8000-000000000006"), /"ok":true/u);
  assert.deepEqual(executed, [
    {
      windowId: 1,
      browserId: "native-browser-cua:test-1",
      workspaceKey: "native-browser-cua:test-1",
    },
    {
      windowId: 2,
      browserId: "native-browser-cua:test-2",
      workspaceKey: "native-browser-cua:test-2",
    },
    {
      windowId: 2,
      browserId: "native-browser-cua:test-2",
      workspaceKey: "native-browser-cua:test-2",
    },
  ]);
  await broker.close();
  await rm(directory, { recursive: true, force: true });
});

test("native broker does not clobber a live instance token when listen fails", async () => {
  // 回归：第二实例竞争同一 endpoint 时 listen 失败，但它仍完成了 broker 创建；
  // 启动期写 token / 退出期 rm 都会顶掉正在服役实例的凭据与 socket 路径，
  // 使其 MCP 请求全部 authentication_failed。
  const directory = await mkdtemp(join(tmpdir(), "native-browser-cua-"));
  const first = createNativeBrowserCuaMcpBroker({
    manager: {
      async execute() {
        throw new Error("must not execute");
      },
    } as never,
    flavor: "test",
    userDataPath: directory,
    temporaryDirectory: directory,
    eligibleWindowResolver: () => null,
    logger: { warn: () => {} },
  });
  await first.readiness;
  await first.registerWindow(1);
  assert.equal(first.availability.browserAvailable, true);
  const tokenFile = join(directory, "codez-native-browser-cua-test-1.token");
  const liveToken = await readFile(tokenFile, "utf8");

  let secondWroteToken = false;
  const second = createNativeBrowserCuaMcpBroker({
    manager: {
      async execute() {
        throw new Error("must not execute");
      },
    } as never,
    flavor: "test",
    userDataPath: directory,
    temporaryDirectory: directory,
    eligibleWindowResolver: () => null,
    logger: { warn: () => {} },
    tokenFileWriter: async () => {
      secondWroteToken = true;
    },
  });
  await second.readiness;
  assert.equal(second.availability.browserAvailable, false);
  assert.equal(secondWroteToken, false);
  // 退出竞争失败的实例也不得删除服役实例的 endpoint 与 token 文件。
  await second.close();
  assert.equal(await readFile(tokenFile, "utf8"), liveToken);
  await stat(
    first.descriptor({
      executable: process.execPath,
      bridgePath: "/fixture/bridge.cjs",
      windowId: 1,
    }).endpoint,
  );

  await first.close();
  await rm(directory, { recursive: true, force: true });
});

for (const action of ["revoke", "close"] as const) {
  test(`native broker ${action} during pending token registration leaves no usable credential`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-browser-cua-race-"));
    const entered = once();
    const release = once();
    const broker = createNativeBrowserCuaMcpBroker({
      manager: { execute: async () => assert.fail("revoked window must not dispatch") } as never,
      flavor: "test",
      userDataPath: directory,
      temporaryDirectory: directory,
      eligibleWindowResolver: (windowId) => ({ id: windowId }) as never,
      logger: { warn: () => {} },
      tokenFileWriter: async (path, contents) => {
        entered.resolve();
        await release.promise;
        await writeFile(path, contents, { mode: 0o600 });
      },
    });
    await broker.ready;
    const registration = broker.registerWindow(1);
    const registrationResult = registration.then(
      () => undefined,
      (error: unknown) => error,
    );
    await entered.promise;
    const ending = action === "close" ? broker.close() : broker.revokeWindow(1);
    release.resolve();
    await ending;
    const failure = await registrationResult;
    if (action === "close") assert.match(String(failure), /closed/u);
    else assert.equal(failure, undefined);
    const descriptor = broker.descriptor({
      executable: process.execPath,
      bridgePath: "/fixture/bridge.cjs",
      windowId: 1,
    });
    assert.equal(descriptor.serviceRunning, false);
    await assert.rejects(stat(descriptor.tokenFile), { code: "ENOENT" });
    if (action === "revoke") await broker.close();
    await rm(directory, { recursive: true, force: true });
  });
}
