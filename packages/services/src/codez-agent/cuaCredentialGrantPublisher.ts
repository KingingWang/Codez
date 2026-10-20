import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CODEZ_CUA_BROKER_GRANT_FILE_ENV_KEY } from "@codez/shared";
import type { ManagedCuaProductHelperHost } from "@codez/codez-cua/broker/server";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";

export const CUA_CREDENTIAL_GRANT_FILE_ENV = CODEZ_CUA_BROKER_GRANT_FILE_ENV_KEY;

export interface CuaCredentialGrant {
  socketPath: string;
  capability: string;
  generation: number;
}

export interface CuaCredentialGrantHandle {
  socketPath: string;
  pluginAuthority: string;
  generation?: number;
  [key: string]: unknown;
}

export interface CuaCredentialGrantPublisher {
  readonly grantFilePath: string;
  publish(startup: Promise<unknown>, options?: { revokeCurrent?: boolean }): Promise<void>;
  dispose(): Promise<void>;
}

function parseGrant(handle: unknown): CuaCredentialGrant {
  if (
    typeof handle !== "object" ||
    handle === null ||
    typeof (handle as CuaCredentialGrantHandle).socketPath !== "string" ||
    !(handle as CuaCredentialGrantHandle).socketPath.trim() ||
    typeof (handle as CuaCredentialGrantHandle).pluginAuthority !== "string" ||
    !(handle as CuaCredentialGrantHandle).pluginAuthority.trim()
  ) {
    throw new Error("Computer Use Helper returned invalid transport credentials.");
  }
  const generation = (handle as CuaCredentialGrantHandle).generation ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Computer Use Helper returned invalid transport credentials.");
  }
  return {
    socketPath: (handle as CuaCredentialGrantHandle).socketPath,
    capability: (handle as CuaCredentialGrantHandle).pluginAuthority,
    generation,
  };
}

/**
 * 为当前 Helper Owner 创建隔离的授权投影。
 *
 * publish 在串行文件 IO 外等待 Helper ready；dispose 先设终态 fence，再等待已进入
 * 本地 IO 队列的有界操作，并只清理本 Owner 目录，pending cold-start 不会拖慢回收。
 */
export async function createCuaCredentialGrantPublisher(options: {
  grantRootDirectory: string;
  logger?: Pick<ServiceLogger, "warn">;
}): Promise<CuaCredentialGrantPublisher> {
  await mkdir(options.grantRootDirectory, { recursive: true, mode: 0o700 });
  const ownerDirectory = await mkdtemp(join(options.grantRootDirectory, "owner-"));
  const grantFilePath = join(ownerDirectory, "broker-grant.json");
  let disposed = false;
  let requestEpoch = 0;
  let temporaryFilePath: string | undefined;
  let ioTail: Promise<unknown> = Promise.resolve();

  const logCleanupFailure = (operation: string, error: unknown): void => {
    // 清理失败只记录分类信息，避免把路径或宿主错误文本中的凭据带进日志。
    options.logger?.warn(undefined, "Computer Use broker grant cleanup failed", {
      operation,
      errorName: error instanceof Error ? error.name : typeof error,
      code:
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined,
    });
  };

  const enqueueIo = (operation: () => Promise<void>): Promise<void> => {
    const result = ioTail.then(operation);
    ioTail = result.catch(() => undefined);
    return result;
  };

  const removeGrant = (): Promise<void> =>
    enqueueIo(async () => {
      if (temporaryFilePath) {
        const staleTemporaryPath = temporaryFilePath;
        temporaryFilePath = undefined;
        await rm(staleTemporaryPath, { force: true });
      }
      await rm(grantFilePath, { force: true });
    });

  return {
    grantFilePath,
    async publish(startup, publishOptions) {
      if (disposed) return;
      const epoch = ++requestEpoch;
      const revocation = publishOptions?.revokeCurrent ? removeGrant() : Promise.resolve();
      try {
        const handle = await startup;
        await revocation;
        if (disposed || epoch !== requestEpoch) return;
        const grant = parseGrant(handle);
        await enqueueIo(async () => {
          if (disposed || epoch !== requestEpoch) return;
          const nextTemporaryFilePath = `${grantFilePath}.${randomBytes(8).toString("hex")}.tmp`;
          temporaryFilePath = nextTemporaryFilePath;
          try {
            await writeFile(nextTemporaryFilePath, `${JSON.stringify(grant)}\n`, {
              encoding: "utf8",
              mode: 0o600,
              flag: "wx",
            });
            if (disposed || epoch !== requestEpoch) return;
            await rename(nextTemporaryFilePath, grantFilePath);
          } finally {
            if (temporaryFilePath === nextTemporaryFilePath) temporaryFilePath = undefined;
            await rm(nextTemporaryFilePath, { force: true });
          }
        });
      } catch (error) {
        if (disposed || epoch !== requestEpoch) return;
        await removeGrant().catch((cleanupError: unknown) => {
          logCleanupFailure("remove_stale_grant", cleanupError);
        });
        options.logger?.warn(undefined, "Computer Use broker grant publication failed", {
          errorName: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    async dispose() {
      disposed = true;
      requestEpoch += 1;
      await ioTail;
      try {
        await rm(ownerDirectory, { recursive: true, force: true });
      } catch (error) {
        logCleanupFailure("remove_owner_directory", error);
      }
    },
  };
}

export function resolveCuaCredentialGrantRootDirectory(appConfigDir: string): string {
  return join(appConfigDir, "computer-use", "grants");
}

export function attachCuaCredentialGrantPublisher(
  host: ManagedCuaProductHelperHost,
  publisher: CuaCredentialGrantPublisher,
): void {
  const invoke = <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return operation();
    } catch (error) {
      return Promise.reject(error);
    }
  };
  // 原因：平台 restart 常直接调用私有 startNow，不经过公开 start；只包装 start 会留下旧 grant。
  for (const method of ["start", "restart", "restartAfterCurrentStart"] as const) {
    const original = host[method].bind(host);
    host[method] = () => {
      const startup = invoke(original);
      const publication = publisher.publish(startup, { revokeCurrent: method !== "start" });
      return startup.finally(() => publication);
    };
  }
  const restartPreserving = host.restartAfterCurrentStartPreservingTransport?.bind(host);
  if (restartPreserving) {
    host.restartAfterCurrentStartPreservingTransport = (options) => {
      const restart = invoke(() => restartPreserving(options));
      const publication = publisher.publish(
        restart.then((result) => result.handle),
        { revokeCurrent: true },
      );
      return restart.finally(() => publication);
    };
  }
}
