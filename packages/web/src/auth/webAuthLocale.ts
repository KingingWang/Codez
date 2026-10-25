import type { WebOAuthProviderId } from "./browserOAuthCredentialRepo.js";

type WebAuthLocale = "zh-CN" | "en-US";

interface WebAuthPageCopy {
  brand: string;
  loginTitle: string;
  loginDescription: string;
  loginAction: Record<WebOAuthProviderId, string>;
  loginRegion: Record<WebOAuthProviderId, string>;
  scanLoginTitle: string;
  scanLoginDescription: string;
  scanLoginPreparing: string;
  scanLoginUnavailable: string;
  openAuthorizeAction: string;
  cliLoginFailed: string;
  callbackTitle: string;
  callbackDescription: string;
  callbackErrorTitle: string;
  callbackErrorDescription: string;
  retryAction: string;
}

const WEB_AUTH_COPY = {
  "zh-CN": {
    brand: "Codez",
    loginTitle: "登录后继续使用 Web 远程控制",
    loginDescription: "请选择与电脑端相同的登录平台，并使用同一账号。",
    loginAction: { zai: "连接 Z.ai 继续使用", bigmodel: "连接 BigModel 继续使用" },
    loginRegion: { zai: "全球", bigmodel: "中国" },
    scanLoginTitle: "用另一台设备扫码登录",
    scanLoginDescription: "请用另一台设备扫码；也可以在此设备打开官方登录页使用手机号登录。",
    scanLoginPreparing: "正在生成本地登录二维码…",
    scanLoginUnavailable: "二维码生成失败，请在此设备打开官方登录页使用手机号登录。",
    openAuthorizeAction: "在此设备登录",
    cliLoginFailed: "登录未完成，请重试。原连接链接会保留。",
    callbackTitle: "正在完成登录",
    callbackDescription: "请稍候，正在校验账号身份。",
    callbackErrorTitle: "登录失败",
    callbackErrorDescription: "授权流程未完成，请重新登录。",
    retryAction: "重新登录",
  },
  "en-US": {
    brand: "Codez",
    loginTitle: "Sign In To Continue",
    loginDescription: "Choose the same sign-in provider and account as on your computer.",
    loginAction: { zai: "Connect to Z.ai", bigmodel: "Connect to BigModel" },
    loginRegion: { zai: "Global", bigmodel: "CN" },
    scanLoginTitle: "Scan with another device",
    scanLoginDescription:
      "Scan with another device, or open the official sign-in page here to use your phone number.",
    scanLoginPreparing: "Generating a local sign-in QR code…",
    scanLoginUnavailable:
      "Could not generate the QR code. Open the official sign-in page here to use your phone number.",
    openAuthorizeAction: "Sign in on this device",
    cliLoginFailed: "Sign-in did not complete. Retry with the same remote-control link.",
    callbackTitle: "Finishing Sign-In",
    callbackDescription: "Verifying your account identity.",
    callbackErrorTitle: "Sign-In Failed",
    callbackErrorDescription: "The authorization flow did not complete. Sign in again.",
    retryAction: "Sign In Again",
  },
} satisfies Record<WebAuthLocale, WebAuthPageCopy>;

function resolveWebAuthLocale(language?: string): WebAuthLocale {
  const candidate =
    language ??
    document.documentElement.lang ??
    navigator.language ??
    navigator.languages?.[0] ??
    "";

  return candidate.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function getWebAuthCopy(locale: WebAuthLocale = resolveWebAuthLocale()): WebAuthPageCopy {
  return WEB_AUTH_COPY[locale];
}
