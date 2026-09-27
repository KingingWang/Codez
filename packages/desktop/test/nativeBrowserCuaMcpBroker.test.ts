import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "node:net";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
    eligibleWindowResolver: () => ({ id: 1 }) as never,
    logger: { warn: () => {} },
  });
  await broker.ready;
  const endpoint = broker.descriptor({
    executable: process.execPath,
    bridgePath: "/fixture/bridge.cjs",
  }).endpoint;
  const tokenFile = join(directory, "codez-native-browser-cua-test.token");
  await broker.tokenReady;
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
    eligibleWindowResolver: () => resolveWindow?.() ?? null,
    logger: { warn: () => {} },
  });
  await broker.readiness;
  const descriptor = broker.descriptor({
    executable: process.execPath,
    bridgePath: "/fixture/bridge.cjs",
  });
  const token = (
    await readFile(join(directory, "codez-native-browser-cua-test.token"), "utf8")
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

test("native broker readiness resolves once and projects token failure fail closed", async () => {
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
  // token 写入现在等 socket 监听成功后才触发（不能把第二实例的凭据顶掉服役实例），
  // 因此写入器是被异步调用的；等它被调用后再拒绝。
  await broker.ready;
  while (!rejectToken) await new Promise((resolve) => setImmediate(resolve));
  rejectToken(new Error("token write fixture failed"));
  await broker.readiness;
  assert.deepEqual(broker.availability, { browserAvailable: false, cuaAvailable: false });
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
  assert.equal(first.availability.browserAvailable, true);
  const tokenFile = join(directory, "codez-native-browser-cua-test.token");
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
    first.descriptor({ executable: process.execPath, bridgePath: "/fixture/bridge.cjs" }).endpoint,
  );

  await first.close();
  await rm(directory, { recursive: true, force: true });
});
