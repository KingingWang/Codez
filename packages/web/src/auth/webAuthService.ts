import {
  parseWebRemoteControlE2eeQrFragment,
  ZAI_PROVIDER_ID,
  type UserInfo,
} from "@codez/shared";
import {
  BrowserOAuthCredentialRepo,
  type WebOAuthProviderId,
} from "./browserOAuthCredentialRepo.js";
import {
  buildOAuthState,
  buildReturnToCallbackUrl,
  buildWebRemoteOAuthRedirectUri,
  isTrustedDevReturnTo,
  parseOAuthState,
  parseOptionalUrl,
  resolveSafeAppReturnTo,
} from "./oauthStateCodec.js";
import { WEB_ZAI_OAUTH_CONFIG, type WebZaiOAuthConfig } from "./webZaiOAuthConfig.js";
import { ZaiWebOAuthProvider } from "./zaiWebOAuthProvider.js";
import { isCodezBrowserExtension } from "../webRemoteControlNativeSocket.js";

interface WebAuthServiceRuntime {
  assign(url: string): void;
  createNonce(): string;
  getCurrentHref(): string;
  getCurrentOrigin(): string;
  replace(url: string): void;
}

interface WebAuthServiceDependencies {
  config?: WebZaiOAuthConfig;
  provider?: ZaiWebOAuthProvider;
  repo?: BrowserOAuthCredentialRepo;
  runtime?: WebAuthServiceRuntime;
  fetcher?: typeof fetch;
}

interface WebAuthLoginOptions {
  devReturnTo?: string;
  appReturnTo?: string;
  redirectUri?: string;
  /** 缺省 zai，保持 /remote 等既有入口行为不变。 */
  provider?: WebOAuthProviderId;
}

export interface WebAuthCallbackResult {
  userInfo: UserInfo;
  appReturnTo: string | null;
}

function createBrowserNonce(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable");
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createBrowserPollToken(): string {
  if (!globalThis.crypto?.getRandomValues) {
    return `${createBrowserNonce().replaceAll("-", "")}${createBrowserNonce().replaceAll("-", "")}`;
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createDefaultRuntime(): WebAuthServiceRuntime {
  return {
    assign: (url) => {
      window.location.assign(url);
    },
    createNonce: createBrowserNonce,
    getCurrentHref: () => window.location.href,
    getCurrentOrigin: () => window.location.origin,
    replace: (url) => {
      window.location.replace(url);
    },
  };
}

function isExtensionRuntimeOrigin(origin: string): boolean {
  if (
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("moz-extension://") ||
    origin.startsWith("safari-web-extension://") ||
    origin.startsWith("orion-extension://")
  ) {
    return true;
  }
  return isCodezBrowserExtension();
}

export class WebAuthService {
  private readonly config: WebZaiOAuthConfig;
  private readonly provider: ZaiWebOAuthProvider;
  private readonly repo: BrowserOAuthCredentialRepo;
  private readonly runtime: WebAuthServiceRuntime;

  constructor(dependencies: WebAuthServiceDependencies = {}) {
    this.config = dependencies.config ?? WEB_ZAI_OAUTH_CONFIG;
    this.provider =
      dependencies.provider ??
      new ZaiWebOAuthProvider(
        this.config,
        Date.now,
        dependencies.fetcher ?? ((...args) => globalThis.fetch(...args)),
      );
    this.repo = dependencies.repo ?? new BrowserOAuthCredentialRepo();
    this.runtime = dependencies.runtime ?? createDefaultRuntime();
  }

  startLogin(options: WebAuthLoginOptions = {}): void {
    const nonce = this.runtime.createNonce();
    const provider = options.provider ?? ZAI_PROVIDER_ID;
    const appReturnTo = options.appReturnTo ?? this.runtime.getCurrentHref();
    const sourceUrl = parseOptionalUrl(appReturnTo);
    const returnToOptions = { currentOrigin: this.runtime.getCurrentOrigin() };
    const redirectUri = buildWebRemoteOAuthRedirectUri(
      options.redirectUri ?? this.config.redirectUri,
      appReturnTo,
      returnToOptions,
    );
    const e2eeHash =
      sourceUrl?.hash && parseWebRemoteControlE2eeQrFragment(sourceUrl.hash)
        ? sourceUrl.hash.trim()
        : "";
    this.repo.savePendingLogin({
      nonce,
      provider,
      redirectUri,
      ...(e2eeHash ? { hash: e2eeHash } : {}),
    });

    const state = buildOAuthState({
      nonce,
      ...(isExtensionRuntimeOrigin(this.runtime.getCurrentOrigin())
        ? {
            provider,
            redirect_uri: redirectUri,
          }
        : {}),
      app_return_to: appReturnTo,
      ...(options.devReturnTo
        ? {
            return_to: buildWebRemoteOAuthRedirectUri(
              options.devReturnTo,
              appReturnTo,
              returnToOptions,
            ),
          }
        : {}),
    });

    this.runtime.assign(
      this.provider.buildAuthorizeUrl({
        state,
        provider,
        redirectUri,
      }),
    );
  }

  async startPollingLogin(
    options: WebAuthLoginOptions = {},
    onAuthorizeUrl?: (authorizeUrl: string) => void,
    signal?: AbortSignal,
  ): Promise<WebAuthCallbackResult | null> {
    const provider = options.provider ?? ZAI_PROVIDER_ID;
    const appReturnTo = options.appReturnTo ?? this.runtime.getCurrentHref();
    const sourceUrl = parseOptionalUrl(appReturnTo);
    const e2eeHash =
      sourceUrl?.hash && parseWebRemoteControlE2eeQrFragment(sourceUrl.hash)
        ? sourceUrl.hash.trim()
        : "";
    const pollToken = createBrowserPollToken();
    const init = await this.provider.initCliFlow({ provider, pollToken });
    onAuthorizeUrl?.(init.authorizeUrl);

    while (!signal?.aborted && Date.now() < init.expiresAt) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, init.pollIntervalMs);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (signal?.aborted) {
        return null;
      }
      try {
        const pollResult = await this.provider.pollCliFlow({
          flowId: init.flowId,
          pollToken,
          provider,
        });
        if (pollResult.status === "pending") {
          continue;
        }
        this.repo.saveTokenSet(pollResult.tokenSet, provider);
        this.repo.saveUserInfo(pollResult.rawUserInfo, provider);
        this.repo.setActiveProvider(provider);
        const resolvedAppReturnTo = resolveSafeAppReturnTo(appReturnTo, {
          currentOrigin: this.runtime.getCurrentOrigin(),
        });
        const normalizedHash = e2eeHash
          ? e2eeHash.startsWith("#")
            ? e2eeHash
            : `#${e2eeHash}`
          : "";
        return {
          userInfo: pollResult.userInfo,
          appReturnTo:
            resolvedAppReturnTo && normalizedHash
              ? `${resolvedAppReturnTo}${normalizedHash}`
              : resolvedAppReturnTo,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("invalid_flow") || message.includes("failed")) {
          throw error;
        }
      }
    }
    return null;
  }

  async handleCallback(url: string): Promise<WebAuthCallbackResult | null> {
    const callback = this.provider.parseCallbackParams(url);
    const statePayload = parseOAuthState(callback.state);
    if (!statePayload) {
      throw new Error("OAuth state is invalid");
    }

    const returnToUrl = parseOptionalUrl(statePayload.return_to);
    if (returnToUrl && returnToUrl.origin !== this.runtime.getCurrentOrigin()) {
      if (this.config.allowDevReturnToRedirect && isTrustedDevReturnTo(returnToUrl)) {
        const redirectUrl = buildReturnToCallbackUrl(returnToUrl.toString(), {
          ...(callback.code ? { code: callback.code } : {}),
          ...(callback.error ? { error: callback.error } : {}),
          state: callback.state,
        });
        if (redirectUrl) {
          this.runtime.replace(redirectUrl);
          return null;
        }
      }
    }

    if (callback.error) {
      throw new Error(`OAuth login failed: ${callback.error}`);
    }

    if (!callback.code) {
      throw new Error("OAuth callback missing code");
    }

    // provider 与回调地址必须取跳转前记下的那条：authorize 参数名和 token 响应里 access_token
    // 的位置都是 provider 特定的，token 请求也要用授权时的完整回调地址。
    const currentOrigin = this.runtime.getCurrentOrigin();
    const stateReturnToUrl = parseOptionalUrl(statePayload.app_return_to);
    const stateHash =
      stateReturnToUrl?.hash && parseWebRemoteControlE2eeQrFragment(stateReturnToUrl.hash)
        ? stateReturnToUrl.hash.trim()
        : undefined;
    const pendingLogin =
      this.repo.takePendingLogin(statePayload.nonce) ??
      (isExtensionRuntimeOrigin(currentOrigin) &&
      statePayload.provider &&
      statePayload.redirect_uri
        ? {
            nonce: statePayload.nonce,
            provider: statePayload.provider,
            redirectUri: statePayload.redirect_uri,
            ...(stateHash ? { hash: stateHash } : {}),
          }
        : null);
    if (!pendingLogin) {
      throw new Error("OAuth CSRF 检测失败");
    }
    const { provider, redirectUri, hash: pendingHash } = pendingLogin;
    const exchange = await this.provider.exchangeToken({
      code: callback.code,
      state: callback.state,
      provider,
      redirectUri,
    });

    this.repo.saveTokenSet(exchange.tokenSet, provider);
    this.repo.saveUserInfo(exchange.rawUserInfo, provider);
    this.repo.setActiveProvider(provider);
    const resolvedAppReturnTo = resolveSafeAppReturnTo(statePayload.app_return_to, {
      currentOrigin: this.runtime.getCurrentOrigin(),
    });
    const normalizedHash = pendingHash
      ? pendingHash.startsWith("#")
        ? pendingHash
        : `#${pendingHash}`
      : "";

    return {
      userInfo: exchange.userInfo,
      appReturnTo:
        resolvedAppReturnTo && normalizedHash
          ? `${resolvedAppReturnTo}${normalizedHash}`
          : resolvedAppReturnTo,
    };
  }

  async restoreCachedSession(): Promise<UserInfo | null> {
    return this.repo.loadCachedSession();
  }

  restoreCachedSessionState() {
    return this.repo.loadCachedSessionState();
  }

  getCodezJwtToken(): string | null {
    return this.repo.loadCodezJwtToken();
  }

  /** 设备页账号行的展示资料；只读，不参与登录判断。 */
  getActiveAccount(): {
    displayName: string;
    avatarUrl?: string;
    provider: WebOAuthProviderId;
  } | null {
    const account = this.repo.loadActiveAccount();
    if (!account) return null;
    const { userInfo, provider } = account;
    return {
      displayName: userInfo.displayName.trim() || userInfo.username,
      ...(userInfo.avatarUrl ? { avatarUrl: userInfo.avatarUrl } : {}),
      provider,
    };
  }

  async logout(): Promise<void> {
    this.repo.clearAll();
  }
}

export function createWebAuthService(dependencies?: WebAuthServiceDependencies): WebAuthService {
  return new WebAuthService(dependencies);
}
