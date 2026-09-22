import { useState } from "react";
import {
  codexAccountReadResponseSchema,
  codexCancelLoginResponseSchema,
  codexLoginResponseSchema,
  type CodexLoginResponse,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import type { CodexSettingsController } from "@/hooks/useCodexSettings.js";
import { codexAuthorizationUrl } from "./codexSettingsData.js";
import { CodexConfirmButton, CodexNotice, CodexSection } from "./CodexSettingsParts.js";
import { useCodexMessages } from "./messages.js";

export function CodexAccountPanel({ controller }: { controller: CodexSettingsController }) {
  const text = useCodexMessages();
  const platform = usePlatform();
  const [apiKey, setApiKey] = useState("");
  const [login, setLogin] = useState<CodexLoginResponse | null>(null);
  const data = controller.snapshot.account?.data;
  const account = data?.account;
  const pending = login && "loginId" in login ? login : null;
  const disabled = controller.busy || !controller.enabled || !data;
  const loginUrl = pending?.type === "chatgpt" ? pending.authUrl : pending?.verificationUrl;
  function start(type: "chatgpt" | "chatgptDeviceCode" | "apiKey") {
    if (disabled || pending || account || (type === "apiKey" && !apiKey.trim())) return;
    const key = apiKey;
    setApiKey("");
    void controller.run(async () => {
      const result = codexLoginResponseSchema.parse(
        await controller.request({
          method: "account/login/start",
          params: type === "apiKey" ? { type, apiKey: key } : { type },
        }),
      );
      setLogin(result);
      if (result.type === "chatgpt") platform.openExternal(codexAuthorizationUrl(result.authUrl));
      if (result.type === "chatgptDeviceCode")
        platform.openExternal(codexAuthorizationUrl(result.verificationUrl));
    });
  }
  return (
    <CodexSection title={text.account}>
      {controller.snapshot.account?.error ? (
        <CodexNotice error>{controller.snapshot.account.error}</CodexNotice>
      ) : null}
      <p className="text-ui-base">
        {account
          ? account.type === "chatgpt"
            ? `${account.email ?? text.signedIn} · ${account.planType}`
            : account.type
          : data
            ? text.noAccount
            : text.notLoaded}
      </p>
      {data && !data.requiresOpenaiAuth ? <CodexNotice>{text.noAuth}</CodexNotice> : null}
      {account ? (
        <CodexConfirmButton
          label={text.logout}
          disabled={disabled}
          onConfirm={() =>
            void controller.run(async () => {
              await controller.request({ method: "account/logout" });
              setLogin(null);
            })
          }
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={disabled || Boolean(pending) || Boolean(account)}
          onClick={() => start("chatgpt")}
        >
          {text.login}
        </Button>
        <Button
          variant="outline"
          disabled={disabled || Boolean(pending) || Boolean(account)}
          onClick={() => start("chatgptDeviceCode")}
        >
          {text.deviceLogin}
        </Button>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          start("apiKey");
        }}
      >
        <label className="min-w-0 flex-1 space-y-1 text-ui-sm">
          {text.apiKey}
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            disabled={disabled || Boolean(pending) || Boolean(account)}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <Button
          type="submit"
          variant="outline"
          disabled={disabled || Boolean(pending) || Boolean(account) || !apiKey.trim()}
        >
          {text.apiLogin}
        </Button>
      </form>
      {pending ? (
        <div className="space-y-2 border-t border-border pt-3">
          <CodexNotice>{text.pending}</CodexNotice>
          {pending.type === "chatgptDeviceCode" ? (
            <p className="text-ui-base">
              {text.userCode}: <code className="select-all font-mono">{pending.userCode}</code>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void controller.run(async () => {
                  if (loginUrl) platform.openExternal(codexAuthorizationUrl(loginUrl));
                })
              }
            >
              {text.openBrowser}
            </Button>
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void controller.run(async () => {
                  codexCancelLoginResponseSchema.parse(
                    await controller.request({
                      method: "account/login/cancel",
                      params: { loginId: pending.loginId },
                    }),
                  );
                  setLogin(null);
                })
              }
            >
              {text.cancel}
            </Button>
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void controller.run(async () => {
                  const result = await controller.request({
                    method: "account/read",
                    params: { refreshToken: true },
                  });
                  if (codexAccountReadResponseSchema.parse(result).account) setLogin(null);
                })
              }
            >
              {text.checkLogin}
            </Button>
          </div>
        </div>
      ) : null}
    </CodexSection>
  );
}
