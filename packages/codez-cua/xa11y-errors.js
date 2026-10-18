function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function isXa11yTimeout(error) {
  // 根因：Windows native 抛出的 HRESULT 不会被 JS wrapper 转成 TimeoutError。
  // 只识别已知超时码，不能把任意 PlatformError 当作可重试超时。
  return (
    error?.name === "TimeoutError" ||
    /(?:\b0x800705b4\b|(?<![\w-])-2147023436\b)/iu.test(errorMessage(error))
  );
}

export function isXa11yPermissionDenied(error) {
  return (
    error?.name === "PermissionDeniedError" ||
    error?.name === "AccessibilityNotEnabledError" ||
    /(?:\b0x80070005\b|(?<![\w-])-2147024891\b|\b(?:permission|access|tcc|screen)\s+denied\b)/iu.test(
      errorMessage(error),
    )
  );
}
