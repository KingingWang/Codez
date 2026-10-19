import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeBundledCodezBuiltinProviderConfig } from "../src/bundledCodezBuiltinProviderConfig.js";

describe("materializeBundledCodezBuiltinProviderConfig", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("在环境固定路径物化 Codez Built-in Provider Config，并复用相同内容", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "codez-remote-provider-config-"));
    tempDirs.push(runtimeRoot);
    const content = emptyRelease(1);

    const firstPath = await materializeBundledCodezBuiltinProviderConfig({
      environmentConfigRoot: runtimeRoot,
      content,
    });
    const secondPath = await materializeBundledCodezBuiltinProviderConfig({
      environmentConfigRoot: runtimeRoot,
      content,
    });

    expect(secondPath).toBe(firstPath);
    expect(firstPath).toBe(
      join(runtimeRoot, "runtime", "provider", "bundled", "codez-builtin.json"),
    );
    await expect(readFile(firstPath, "utf8")).resolves.toBe(`${content}\n`);
  });

  it("内容变化时在固定路径替换资源副本", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "codez-remote-provider-config-"));
    tempDirs.push(runtimeRoot);
    const firstContent = emptyRelease(1);
    const secondContent = emptyRelease(2);

    const firstPath = await materializeBundledCodezBuiltinProviderConfig({
      environmentConfigRoot: runtimeRoot,
      content: firstContent,
    });
    const secondPath = await materializeBundledCodezBuiltinProviderConfig({
      environmentConfigRoot: runtimeRoot,
      content: secondContent,
    });

    expect(secondPath).toBe(firstPath);
    await expect(readFile(secondPath, "utf8")).resolves.toBe(`${secondContent}\n`);
  });

  it("发现损坏资源副本时从有效随包资源重建", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "codez-remote-provider-config-"));
    tempDirs.push(runtimeRoot);
    const content = emptyRelease(1);
    const filePath = await materializeBundledCodezBuiltinProviderConfig({
      environmentConfigRoot: runtimeRoot,
      content,
    });
    await writeFile(filePath, "corrupted", "utf8");

    await expect(
      materializeBundledCodezBuiltinProviderConfig({ environmentConfigRoot: runtimeRoot, content }),
    ).resolves.toBe(filePath);
    await expect(readFile(filePath, "utf8")).resolves.toBe(`${content}\n`);
  });
});

function emptyRelease(revision: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: { templateRules: [], providerRules: [] },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  });
}
