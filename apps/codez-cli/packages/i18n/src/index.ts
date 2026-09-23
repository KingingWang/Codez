import type { UiLocale, SupportedLocale } from "@codez/contracts";
import { enUS } from "./locales/en-US.js";
import { zhCN } from "./locales/zh-CN.js";
import {
  DEFAULT_LOCALE,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "./locale.js";
import type { CodezCopy } from "./types.js";

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
};
export type { LocaleDetectionInput } from "./locale.js";
export type { CliCopy, TuiCopy, UiLocale, SupportedLocale, CodezCopy } from "./types.js";

const CATALOGS: Record<SupportedLocale, CodezCopy> = {
  "en-US": enUS,
  "zh-CN": zhCN,
};

export function getCodezCopy(locale?: UiLocale | string, detected?: string | null): CodezCopy {
  return CATALOGS[resolveLocale(locale, detected)];
}
