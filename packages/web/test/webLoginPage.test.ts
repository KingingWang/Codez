// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebLoginPage } from "../src/auth/WebLoginPage.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("qrcode", () => ({
  default: {
    toString: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg" />'),
  },
}));

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("手机远控登录页", () => {
  it.each(["zh-CN", "en-US"] as const)("%s 页头显示品牌与本地化登录标题", (lang) => {
    document.documentElement.lang = lang;
    const html = renderToStaticMarkup(
      createElement(WebLoginPage, { onLogin: () => {}, onOpenAuthorize: () => {} }),
    );
    expect(html).toContain("Codez");
    expect(html).toContain(
      lang === "zh-CN" ? "登录后继续使用 Web 远程控制" : "Sign In To Continue",
    );
  });

  it("第三方登录页二维码不显示时，扩展仍用同一官方授权链接在本地显示可扫码二维码", async () => {
    document.documentElement.lang = "zh-CN";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const authorizeUrl = "https://bigmodel.cn/login?appId=zcode&state=flow-1";
    const onLogin = vi.fn(
      (_provider: "zai" | "bigmodel", showAuthorizeQr: (url: string) => void) => {
        showAuthorizeQr(authorizeUrl);
        return new Promise<void>(() => {});
      },
    );
    const onOpenAuthorize = vi.fn();
    await act(async () => root?.render(createElement(WebLoginPage, { onLogin, onOpenAuthorize })));
    const bigmodelButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("BigModel"),
    );
    expect(bigmodelButton).toBeDefined();
    await act(async () => bigmodelButton?.click());

    await vi.waitFor(() => {
      const image = container?.querySelector<HTMLImageElement>('[data-testid="web-auth-cli-qr"]');
      expect(image?.src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
      expect(decodeURIComponent(image!.src.split(",")[1]!)).toContain("<svg");
    });
    expect(onLogin).toHaveBeenCalledWith("bigmodel", expect.any(Function));
    expect(onOpenAuthorize).not.toHaveBeenCalled();

    const sameDeviceButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("在此设备登录"),
    );
    expect(sameDeviceButton).toBeDefined();
    await act(async () => sameDeviceButton?.click());
    expect(onOpenAuthorize).toHaveBeenCalledExactlyOnceWith(authorizeUrl);
  });
});
