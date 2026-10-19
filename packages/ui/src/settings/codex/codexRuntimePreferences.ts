// Pure adapter boundary: old app preferences must not block native conversation subscriptions.
export function resolveDesktopRuntimePreferences<
  T extends {
    askUserQuestionAutoResolutionEnabled: boolean;
    modelIoFullRetentionEnabled?: boolean;
  },
>(preferences: T, nativeCodex: boolean): T {
  return nativeCodex
    ? {
        ...preferences,
        askUserQuestionAutoResolutionEnabled: false,
        modelIoFullRetentionEnabled: false,
      }
    : preferences;
}
