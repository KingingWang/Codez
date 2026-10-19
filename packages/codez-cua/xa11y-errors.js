function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function isXa11yTimeout(error) {
  // 根因：Windows native/.NET 抛出的 HRESULT 不会被 JS wrapper 转成 TimeoutError。
  // Win32 与 COR_E_TIMEOUT 可能分别以十六进制或带符号十进制出现在原始 Error message；
  // 只精确识别这两个已知超时码，不能把任意 PlatformError 当作可重试超时。
  return (
    error?.name === "TimeoutError" ||
    /(?:\b0x(?:800705b4|80131505)\b|(?<![\w-])-2147023436\b|(?<![\w-])-2146233083\b)/iu.test(
      errorMessage(error),
    )
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
