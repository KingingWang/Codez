/**
 * 构建期开关：为真时安装包使用 Preview 身份，而后端环境仍由 `CODEZ_ENV` 单独决定。
 * 典型用法是 `CODEZ_ENV=production CODEZ_PREVIEW_IDENTITY=1`，得到一个连接生产后端、
 * 可与正式版并排安装的 `Codez Preview`。
 */
export const CODEZ_PREVIEW_IDENTITY_ENV = "CODEZ_PREVIEW_IDENTITY";

export function resolveDesktopRuntime(env = process.env) {
  const value = env.CODEZ_DESKTOP_RUNTIME?.trim() || "codex";
  if (value !== "codex" && value !== "legacy") {
    throw new Error(`invalid CODEZ_DESKTOP_RUNTIME=${value}; expected codex or legacy`);
  }
  return value;
}

const PRODUCTION_IDENTITY = Object.freeze({
  flavor: "production",
  appId: "dev.codez.app",
  productName: "Codez",
  linuxExecutableName: "codez",
  linuxPackageName: "codez",
  cuaHelperInstallVariant: null,
});

const PREVIEW_IDENTITY = Object.freeze({
  flavor: "preview",
  appId: "dev.codez.app.preview",
  productName: "Codez Preview",
  linuxExecutableName: "codez-preview",
  linuxPackageName: "codez-preview",
  cuaHelperInstallVariant: "preview",
});

const CODEX_IDENTITY = Object.freeze({
  flavor: "codex",
  appId: "io.github.kingingwang.codez.codex",
  productName: "Codez Codex",
  linuxExecutableName: "codez-codex",
  linuxPackageName: "codez-codex",
  cuaHelperInstallVariant: "codex",
});

export const desktopProductIdentities = Object.freeze({
  production: PRODUCTION_IDENTITY,
  preview: PREVIEW_IDENTITY,
  codex: CODEX_IDENTITY,
});

function normalizeDesktopCodezEnv(env) {
  return env.CODEZ_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
}

/**
 * 开关只有一种开启拼写 `1`（`0` / 空 = 关闭），与 CI workflow 规则和 release 门的
 * `$CODEZ_PREVIEW_IDENTITY == "1"` 精确比较保持同一套语义。其它拼写在构建期直接失败，
 * 避免 `true` 之类在 YAML 路由层漏匹配、却在脚本层被当成开启，把 Preview 包打进生产验收目录。
 */
export function isPreviewIdentityRequested(env = process.env) {
  const value = env[CODEZ_PREVIEW_IDENTITY_ENV]?.trim() ?? "";
  if (value === "1") {
    return true;
  }
  if (value === "" || value === "0") {
    return false;
  }
  throw new Error(
    `invalid ${CODEZ_PREVIEW_IDENTITY_ENV}=${env[CODEZ_PREVIEW_IDENTITY_ENV]}; expected 1 or 0`,
  );
}

/**
 * 产品身份（flavor）与后端环境（`CODEZ_ENV`）是两个轴：
 * - 默认 Codex 身份；以下 Preview/production 规则只适用于显式 legacy runtime。
 * - `CODEZ_ENV=test` 一律是 Preview，测试后端不能顶着正式 `Codez` 身份覆盖用户的正式安装；
 * - `CODEZ_ENV=production` 默认是正式身份，显式 `CODEZ_PREVIEW_IDENTITY=1` 时改用 Preview 身份。
 * 未知 `CODEZ_ENV` 继续按 test 处理，和共享层 normalizeCodezEnv 的 fail-safe 默认值一致。
 */
export function resolveDesktopProductFlavor(env = process.env) {
  if (resolveDesktopRuntime(env) === "codex") return "codex";
  if (isPreviewIdentityRequested(env)) {
    return "preview";
  }
  return normalizeDesktopCodezEnv(env) === "production" ? "production" : "preview";
}

export function resolveDesktopProductIdentity(env = process.env) {
  return desktopProductIdentities[resolveDesktopProductFlavor(env)];
}

/**
 * 产物文件名后缀标记的是后端环境而不是身份：`_TEST` 只出现在测试后端的安装包上。
 * 生产后端的 Preview 包靠 productName（`Codez Preview-<version>-...`）与正式包区分。
 */
export function resolveDesktopArtifactSuffix(env = process.env) {
  return normalizeDesktopCodezEnv(env) === "test" ? "_TEST" : "";
}

/**
 * 返回 Windows Shell 使用的 AppUserModelId。
 *
 * 打包态必须复用 electron-builder 的 appId，否则快捷方式里的 AUMID、开始菜单索引
 * 和运行中的 Electron 进程会被 Windows 视为三个不同的应用。开发态继续保留旧身份，
 * 避免本地调试快捷方式和正式/Preview 安装包互相污染。
 */
export function resolveWindowsAppUserModelIdForFlavor(flavor, runtime = { isPackaged: true }) {
  if (runtime.isPackaged === false) {
    if (flavor === "codex") return CODEX_IDENTITY.appId;
    return "cn.aminer.codez";
  }
  return desktopProductIdentities[
    flavor === "codex" ? "codex" : flavor === "preview" ? "preview" : "production"
  ].appId;
}

export function resolveWindowsAppUserModelId(env = process.env, runtime = { isPackaged: true }) {
  return resolveWindowsAppUserModelIdForFlavor(resolveDesktopProductFlavor(env), runtime);
}
