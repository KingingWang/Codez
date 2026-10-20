/** Only the isolated Linux root QA process may disable Electron's sandbox. */
export function isolatedElectronSandboxEnv(platform, uid) {
  return platform === "linux" && uid === 0 ? { ELECTRON_DISABLE_SANDBOX: "1" } : {};
}
