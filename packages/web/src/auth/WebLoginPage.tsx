import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@codez/shared";
import { CodezAppLogo } from "@codez/ui/app-logo";
import { renderOAuthProviderIcon } from "@codez/ui/oauth-provider-icon";
import type { WebOAuthProviderId } from "./browserOAuthCredentialRepo.js";
import { Button } from "@codez/ui";
import { getWebAuthCopy } from "./webAuthLocale.js";

interface WebLoginPageProps {
  onLogin: (
    provider: WebOAuthProviderId,
    showAuthorizeQr: (authorizeUrl: string) => void,
  ) => Promise<void> | void;
  onOpenAuthorize: (authorizeUrl: string) => void;
}

export function WebLoginPage({ onLogin, onOpenAuthorize }: WebLoginPageProps) {
  const copy = getWebAuthCopy();
  const [submittingProvider, setSubmittingProvider] = useState<WebOAuthProviderId | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrUnavailable, setQrUnavailable] = useState(false);
  const [loginFailed, setLoginFailed] = useState(false);

  useEffect(() => {
    if (!authorizeUrl) return;
    let cancelled = false;
    // Bug 原因：第三方授权页二维码缺失时用户无扫码入口；此处用纯 JS 生成
    // 本地 SVG，避免再依赖第三方脚本或浏览器 Canvas 能力。
    void QRCode.toString(authorizeUrl, { type: "svg", margin: 1, width: 224 })
      .then((svg) => {
        if (!cancelled) setQrDataUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => {
        if (!cancelled) setQrUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [authorizeUrl]);

  const startLogin = (provider: WebOAuthProviderId) => {
    if (submittingProvider) return;
    setSubmittingProvider(provider);
    setAuthorizeUrl(null);
    setQrDataUrl(null);
    setQrUnavailable(false);
    setLoginFailed(false);
    try {
      void Promise.resolve(onLogin(provider, setAuthorizeUrl)).catch(() => {
        setSubmittingProvider(null);
        setAuthorizeUrl(null);
        setQrDataUrl(null);
        setLoginFailed(true);
      });
    } catch {
      setSubmittingProvider(null);
      setLoginFailed(true);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-sm rounded-lg border border-card-border bg-card p-5 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <CodezAppLogo className="size-10" />
          <div className="min-w-0">
            <div className="text-ui-xs font-medium text-foreground">{copy.brand}</div>
            <h1 className="text-ui-lg font-medium text-foreground">{copy.loginTitle}</h1>
          </div>
        </div>
        <p className="mb-5 text-ui-xs leading-6 text-foreground-subtle">{copy.loginDescription}</p>
        <div className="space-y-2">
          {[ZAI_PROVIDER_ID, BIGMODEL_PROVIDER_ID].map((provider) => (
            <Button
              key={provider}
              type="button"
              size="lg"
              className="w-full"
              disabled={submittingProvider !== null}
              onClick={() => startLogin(provider)}
            >
              {renderOAuthProviderIcon(provider, "size-4")}
              <span>
                {submittingProvider === provider
                  ? `${copy.callbackTitle}…`
                  : copy.loginAction[provider]}
              </span>
              <span className="ml-1 inline-flex h-5 shrink-0 items-center rounded-full border border-primary-foreground/30 px-2 text-ui-xs font-medium leading-none text-primary-foreground/60">
                {copy.loginRegion[provider]}
              </span>
            </Button>
          ))}
        </div>
        {loginFailed ? (
          <p role="alert" className="mt-4 text-ui-sm text-destructive">
            {copy.cliLoginFailed}
          </p>
        ) : null}
        {authorizeUrl ? (
          <section className="mt-5 border-t border-border pt-4 text-center">
            <h2 className="text-ui-base font-medium">{copy.scanLoginTitle}</h2>
            <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">
              {copy.scanLoginDescription}
            </p>
            {qrDataUrl ? (
              <img
                data-testid="web-auth-cli-qr"
                className="mx-auto mt-3 size-44 max-w-full rounded-md"
                src={qrDataUrl}
                alt={copy.scanLoginTitle}
              />
            ) : (
              <p className="mt-3 text-ui-sm text-foreground-subtle" role="status">
                {qrUnavailable ? copy.scanLoginUnavailable : copy.scanLoginPreparing}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="mt-4 w-full"
              onClick={() => onOpenAuthorize(authorizeUrl)}
            >
              {copy.openAuthorizeAction}
            </Button>
          </section>
        ) : null}
      </section>
    </main>
  );
}
