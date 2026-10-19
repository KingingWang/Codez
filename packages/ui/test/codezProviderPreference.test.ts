import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCodezSessionStore } from "../src/store/codezSessionStore.js";
import { LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY } from "../src/lib/codezProviderPreference.js";

function createStorageMock(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));

  return {
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

describe("agent provider preference", () => {
  beforeEach(() => {
    useCodezSessionStore.setState((state) => ({
      ...state,
      workspaces: {},
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("startDraft 选择旧 provider 时也会立即归一最近一次选择", () => {
    const storage = createStorageMock();
    vi.stubGlobal("window", { localStorage: storage });

    useCodezSessionStore.getState().startDraft("/tmp/workspace-draft", "gemini");

    expect(storage.getItem(LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY)).toBe("glm");
    expect(
      useCodezSessionStore.getState().getWorkspaceState("/tmp/workspace-draft").selectedProvider,
    ).toBe("glm");
  });
});
