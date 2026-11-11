import { getCodezCopy, type SupportedLocale, type UiLocale } from "@codez/i18n";

export function formatCliHelp(
  version: string,
  locale?: UiLocale,
  detectedLocale?: SupportedLocale,
): string {
  return getCodezCopy(locale, detectedLocale).cli.help(version);
}
