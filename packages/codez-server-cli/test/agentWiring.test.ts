import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReleaseAgentWiring, resolveBundledAgentWiring } from "../src/runtime/agentWiring.js";

const temporaryDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codez-server-agent-wiring-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("resolveBundledAgentWiring", () => {
  it("returns wiring for a bundled codez.cjs next to the entry", async () => {
    const entryDir = await makeTempDir();
    const bundlePath = join(entryDir, "codez.cjs");
    await writeFile(bundlePath, "// bundle\n", "utf8");

    const wiring = await resolveBundledAgentWiring(entryDir, {});
    expect(wiring).not.toBeNull();
    expect(wiring?.CODEZ_AGENT_SERVER_COMMAND).toBe(process.execPath);
    expect(JSON.parse(wiring?.CODEZ_AGENT_SERVER_ARGS_JSON ?? "[]")).toEqual([
      bundlePath,
      "app-server",
      "--stdio",
    ]);
  });

  it("keeps an explicit CODEZ_AGENT_SERVER_COMMAND untouched", async () => {
    const entryDir = await makeTempDir();
    await writeFile(join(entryDir, "codez.cjs"), "// bundle\n", "utf8");

    const wiring = await resolveBundledAgentWiring(entryDir, {
      CODEZ_AGENT_SERVER_COMMAND: "/custom/agent",
    });
    expect(wiring).toBeNull();
  });

  it("returns null when no bundled codez.cjs exists (dev workspace)", async () => {
    const entryDir = await makeTempDir();
    expect(await resolveBundledAgentWiring(entryDir, {})).toBeNull();
  });

  it("prefers the packaged codex bridge when the release carries runtime/codex", async () => {
    // 回归：远端 Host 只有注入 CODEZ_CODEX_BRIDGE_PATH 才会走 codex bridge；
    // 只注入 codez.cjs 的 app-server 不认识 codex/request（Method not found）。
    const entryDir = await makeTempDir();
    await writeFile(join(entryDir, "codez.cjs"), "// bundle\n", "utf8");
    const bridgePath = join(entryDir, "codex", "bridge.cjs");
    await mkdir(join(entryDir, "codex"), { recursive: true });
    await writeFile(bridgePath, "// bridge\n", "utf8");

    const wiring = await resolveBundledAgentWiring(entryDir, {});
    expect(wiring).toEqual({ CODEZ_CODEX_BRIDGE_PATH: bridgePath });
  });

  it("keeps an explicit CODEZ_CODEX_BRIDGE_PATH untouched", async () => {
    const entryDir = await makeTempDir();
    await writeFile(join(entryDir, "codez.cjs"), "// bundle\n", "utf8");
    await mkdir(join(entryDir, "codex"), { recursive: true });
    await writeFile(join(entryDir, "codex", "bridge.cjs"), "// bridge\n", "utf8");

    expect(
      await resolveBundledAgentWiring(entryDir, {
        CODEZ_CODEX_BRIDGE_PATH: "/custom/bridge.cjs",
      }),
    ).toBeNull();
    expect(
      createReleaseAgentWiring("/release/runtime", "/release/runtime/node", {
        CODEZ_CODEX_BRIDGE_PATH: "/custom/bridge.cjs",
      }),
    ).toBeNull();
  });

  it("recomputes automatic wiring from each candidate release runtime", () => {
    const oldRuntime = "/releases/old/runtime";
    const newRuntime = "/releases/new/runtime";

    expect(createReleaseAgentWiring(oldRuntime, join(oldRuntime, "node"), {})).toEqual({
      CODEZ_AGENT_SERVER_COMMAND: join(oldRuntime, "node"),
      CODEZ_AGENT_SERVER_ARGS_JSON: JSON.stringify([join(oldRuntime, "codez.cjs"), "app-server", "--stdio"]),
    });
    expect(createReleaseAgentWiring(newRuntime, join(newRuntime, "node"), {})).toEqual({
      CODEZ_AGENT_SERVER_COMMAND: join(newRuntime, "node"),
      CODEZ_AGENT_SERVER_ARGS_JSON: JSON.stringify([join(newRuntime, "codez.cjs"), "app-server", "--stdio"]),
    });
  });

  it("does not replace an explicit agent command while computing release wiring", () => {
    expect(createReleaseAgentWiring("/release/runtime", "/release/runtime/node", {
      CODEZ_AGENT_SERVER_COMMAND: "/custom/agent",
    })).toBeNull();
  });

  it("wires the packaged codex bridge instead of codez.cjs when the release carries it", async () => {
    const runtimeRoot = await makeTempDir();
    const bridgePath = join(runtimeRoot, "codex", "bridge.cjs");
    await mkdir(join(runtimeRoot, "codex"), { recursive: true });
    await writeFile(bridgePath, "// bridge\n", "utf8");

    const wiring = createReleaseAgentWiring(runtimeRoot, join(runtimeRoot, "node"), {});
    // 不能同时注入 CODEZ_AGENT_SERVER_COMMAND：它在 Host 解析链中优先级最高，
    // 存在时 codex bridge 永远不会被选中。
    expect(wiring).toEqual({ CODEZ_CODEX_BRIDGE_PATH: bridgePath });
  });
});
