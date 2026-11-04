// Pure adapter boundary: unsupported retention must not block native conversation subscriptions.
export function resolveDesktopRuntimePreferences<
  T extends {
    askUserQuestionAutoResolutionEnabled: boolean;
    modelIoFullRetentionEnabled?: boolean;
  },
>(preferences: T, nativeCodex: boolean): T {
  return nativeCodex
    ? {
        ...preferences,
        // 原生普通提问由 broker 实现同一自动继续契约，不能在适配边界强制关闭。
        modelIoFullRetentionEnabled: false,
      }
    : preferences;
}
