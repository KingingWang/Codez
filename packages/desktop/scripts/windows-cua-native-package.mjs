import { isAbsolute, resolve } from "node:path";

export const WINDOWS_CUA_XA11Y_NATIVE_ROOT_ENV = "CODEZ_CUA_WINDOWS_XA11Y_NATIVE_ROOT";

const WINDOWS_XA11Y_NATIVE_PACKAGES = Object.freeze({
  arm64: "@crowecawcaw/xa11y-win32-arm64-msvc",
  x64: "@crowecawcaw/xa11y-win32-x64-msvc",
});

export function resolveWindowsCuaNativePackageRoots({ targetPlatform, env = process.env }) {
  if (targetPlatform?.os !== "win32") return undefined;
  const packageName = WINDOWS_XA11Y_NATIVE_PACKAGES[targetPlatform.arch];
  if (!packageName) {
    throw new Error(
      `[windows-cua-native-package] unsupported Windows architecture: ${String(targetPlatform.arch)}`,
    );
  }
  const configuredRoot = env[WINDOWS_CUA_XA11Y_NATIVE_ROOT_ENV]?.trim();
  // 根因：只修改 JS 发现路径仍会调用 npm addon 中的 desktop-root UIA 查询。
  // Windows 出包必须消费同版本源码修补件，不能静默回退到未修复的预编译 addon。
  if (!configuredRoot) {
    throw new Error(
      `[windows-cua-native-package] ${WINDOWS_CUA_XA11Y_NATIVE_ROOT_ENV} is required for Windows packaging`,
    );
  }
  if (!isAbsolute(configuredRoot)) {
    throw new Error(
      `[windows-cua-native-package] ${WINDOWS_CUA_XA11Y_NATIVE_ROOT_ENV} must be an absolute path`,
    );
  }
  return { [packageName]: resolve(configuredRoot) };
}
