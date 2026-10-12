import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEB_REMOTE_CONTROL_E2EE_PAGE_URL,
  resolveWebRemoteControlPageUrl,
} from "../src/main/webRemoteControlPageUrl.js";

describe("trusted mobile remote-control page", () => {
  it("uses the independent Pages origin by default for packaged and development builds", () => {
    expect(DEFAULT_WEB_REMOTE_CONTROL_E2EE_PAGE_URL).toBe(
      "https://kingingwang.github.io/Codez/remote/v4/",
    );
    expect(resolveWebRemoteControlPageUrl({ isPackaged: true })).toBe(
      DEFAULT_WEB_REMOTE_CONTROL_E2EE_PAGE_URL,
    );
    expect(resolveWebRemoteControlPageUrl({ isPackaged: false })).toBe(
      DEFAULT_WEB_REMOTE_CONTROL_E2EE_PAGE_URL,
    );
  });

  it("allows an explicit trusted override but ignores the legacy override in a packaged build", () => {
    expect(
      resolveWebRemoteControlPageUrl({
        isPackaged: true,
        e2eeUrl: " https://independent.example/remote/v4/ ",
        legacyUrl: "https://relay.example/remote/v4/",
      }),
    ).toBe("https://independent.example/remote/v4/");
    expect(
      resolveWebRemoteControlPageUrl({
        isPackaged: true,
        legacyUrl: "https://relay.example/remote/v4/",
      }),
    ).toBe(DEFAULT_WEB_REMOTE_CONTROL_E2EE_PAGE_URL);
    expect(
      resolveWebRemoteControlPageUrl({
        isPackaged: false,
        legacyUrl: " http://localhost:5173/remote/ ",
      }),
    ).toBe("http://localhost:5173/remote/");
  });
});
