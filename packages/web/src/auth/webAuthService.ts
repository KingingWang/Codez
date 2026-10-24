import { createBrowserNonce } from "#src/auth/oauthStateCodec.js";
import {
  BIGMODEL_PROVIDER_ID,
  parseWebRemoteControlE2eeQrFragment,
  ZAI_PROVIDER_ID,
  type UserInfo,
} from "@codez/shared";
import {
  initializeRegionalOAuth,
  pollRegionalOAuth,
  waitForRegionalPoll,
} from "#src/auth/webRegionalOAuth.js";
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
  openAuthorization?(): { navigate(url: string): void; close(): void; isClosed(): boolean } | null;
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
  signal?: AbortSignal;
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
    openAuthorization: () => {
      const popup = window.open("about:blank", "_blank");
      if (!popup) return null;
      popup.opener = null;
      return {
        navigate: (url) => {
          popup.location.href = url;
        },
        close: () => popup.close(),
        isClosed: () => popup.closed,
      };
    },
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
  private loginController: AbortController | null = null;

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

  async startLogin(options: WebAuthLoginOptions = {}): Promise<void> {
    this.loginController?.abort();
    if (options.provider === BIGMODEL_PROVIDER_ID) {
      await this.startLegacyLogin(options);
      return;
    }
    const controller = new AbortController();
    this.loginController = controller;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const popup = this.runtime.openAuthorization?.();
    const nonce = this.runtime.createNonce();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!popup) throw new Error("Authorization popup was blocked");
      controller.signal.throwIfAborted();
      const expected = await this.repo.beginLoginAttempt(nonce);
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      const provider = options.provider ?? ZAI_PROVIDER_ID;
      const flow = await initializeRegionalOAuth(provider, token, controller.signal);
      controller.signal.throwIfAborted();
      if (!this.repo.ownsLoginAttempt(nonce, expected))
        throw new Error("OAuth session was superseded");
      expiryTimer = setTimeout(
        () => controller.abort(new Error("OAuth flow expired")),
        flow.expiresAt - Date.now(),
      );
      // 服务端callback由上游完成；原页只轮询，不改写redirect，不把flow凭据放到URL或存储。
      popup.navigate(flow.authorizeUrl);
      while (true) {
        if (!this.repo.ownsLoginAttempt(nonce, expected))
          throw new Error("OAuth session was superseded");
        const session = await pollRegionalOAuth(flow, token, controller.signal);
        if (session) {
          if (
            !(await this.repo.commitPrimarySession(
              { ...session, provider, revision: nonce },
              expected,
              nonce,
              controller.signal,
            ))
          )
            throw new Error("OAuth session was superseded");
          const destination = resolveSafeAppReturnTo(
            options.appReturnTo ?? this.runtime.getCurrentHref(),
            { currentOrigin: this.runtime.getCurrentOrigin() },
          );
          this.runtime.replace(destination ?? "/remote/v4");
          return;
        }
        if (popup.isClosed()) throw new Error("Authorization window was closed");
        await waitForRegionalPoll(flow.intervalMs, controller.signal);
      }
    } finally {
      clearTimeout(expiryTimer);
      options.signal?.removeEventListener("abort", abort);
      if (this.loginController === controller) this.loginController = null;
      popup?.close();
      await this.repo.finishLoginAttempt(nonce);
    }
  }

  private async startLegacyLogin(options: WebAuthLoginOptions): Promise<void> {
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
    const expectedSession = await this.repo.beginLoginAttempt(nonce);
    const e2eeHash =
      sourceUrl?.hash && parseWebRemoteControlE2eeQrFragment(sourceUrl.hash)
        ? sourceUrl.hash.trim()
        : "";
    this.repo.savePendingLogin({
      nonce,
      provider,
      redirectUri,
      expectedSession,
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
    const { provider, redirectUri, expectedSession, hash: pendingHash } = pendingLogin;
    // 起点快照来自发起时；迟到callback不能重新领取当前会话的写入资格。
    if (!this.repo.ownsLoginAttempt(pendingLogin.nonce, expectedSession))
      throw new Error("OAuth session was superseded");
    const exchange = await this.provider.exchangeToken({
      code: callback.code,
      state: callback.state,
      provider,
      redirectUri,
    });

    const token = exchange.tokenSet.codezJwtToken;
    if (
      !token ||
      !(await this.repo.commitPrimarySession(
        {
          provider,
          codezJwtToken: token,
          userInfo: exchange.userInfo,
          revision: this.runtime.createNonce(),
          ...(exchange.tokenSet.accessToken
            ? { businessAccessToken: exchange.tokenSet.accessToken }
            : {}),
        },
        expectedSession,
        pendingLogin.nonce,
      ))
    )
      throw new Error("OAuth session was superseded");
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

  subscribeSessionChange(listener: () => void): () => void {
    return this.repo.subscribeSessionChange(listener);
  }

  getSessionRevision(): string | null {
    return this.repo.getSessionRevision();
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
    this.loginController?.abort();
    await this.repo.clearSession();
  }
}

export function createWebAuthService(dependencies?: WebAuthServiceDependencies): WebAuthService {
  return new WebAuthService(dependencies);
}
