import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  CODEZ_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@codez/provider-node";
import {
  SEA_CODEZ_BUILTIN_PROVIDER_CONFIG_ASSET_KEY,
  prepareCliProviderRuntimeEnv,
} from "../src/provider-runtime-env.js";

const temporaryDirectories: string[] = [];

test.afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("preserves explicitly injected provider runtime paths", async () => {
  const prepared = await prepareCliProviderRuntimeEnv({
    argv: ["--prompt", "hello"],
    env: {
      [CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: "/injected/codez-builtin.json",
      [CODEZ_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: "/injected/personal.json",
    },
  });

  assert.deepEqual(prepared, {
    [CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: "/injected/codez-builtin.json",
    [CODEZ_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: "/injected/personal.json",
  });
});

test("resolves the development Codez Built-in Config and shared Personal Config", async () => {
  const root = await temporaryDirectory();
  const entrypoint = join(root, "apps/codez-cli/packages/cli/src/main.ts");
  const codezBuiltinFilePath = join(root, "config/provider/codez-builtin.json");
  await mkdir(dirname(entrypoint), { recursive: true });
  await mkdir(dirname(codezBuiltinFilePath), { recursive: true });
  // 随包配置按入口真实路径（解析软链接后）定位，入口文件必须真实存在。
  await writeFile(entrypoint, "");
  await writeFile(codezBuiltinFilePath, EMPTY_RELEASE);

  const prepared = await prepareCliProviderRuntimeEnv({
    argv: ["tui"],
    dataBaseDir: join(root, "home"),
    entrypoint,
    env: {},
    appVersion: "test-version",
    platform: "test-platform",
  });

  assertActiveConfigPath(prepared[CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV], join(root, "home"));
  assert.equal(
    prepared[CODEZ_PERSONAL_PROVIDER_CONFIG_FILE_ENV],
    join(root, "home/.codez/v2/provider_config.json"),
  );
  const activeFilePath = prepared[CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV];

  const loginPrepared = await prepareCliProviderRuntimeEnv({
    argv: ["login"],
    dataBaseDir: join(root, "home"),
    entrypoint,
    env: {},
    appVersion: "test-version",
    platform: "test-platform",
  });
  assert.equal(loginPrepared[CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV], activeFilePath);
  const logoutPrepared = await prepareCliProviderRuntimeEnv({
    argv: ["logout"],
    dataBaseDir: join(root, "home"),
    entrypoint,
    env: {},
    appVersion: "test-version",
    platform: "test-platform",
  });
  assert.equal(logoutPrepared[CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV], activeFilePath);
  // 临时目录本身可能经过软链接（macOS 的 /tmp、/var），随包配置报告的是真实路径。
  assert.equal(
    prepared.CODEZ_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE,
    await realpath(codezBuiltinFilePath),
  );
  await assert.rejects(access(join(dirname(activeFilePath!), "codez-builtin-refresh.json")));
});

test("materializes the SEA config in the fixed environment resource path, separate from downloads", async () => {
  const root = await temporaryDirectory();
  const codezBuiltinContent = EMPTY_RELEASE;
  let reads = 0;
  const prepared = await prepareCliProviderRuntimeEnv({
    argv: ["--prompt", "hello"],
    dataBaseDir: root,
    env: {},
    sea: {
      getAsset(key, encoding) {
        assert.equal(key, SEA_CODEZ_BUILTIN_PROVIDER_CONFIG_ASSET_KEY);
        assert.equal(encoding, "utf8");
        reads += 1;
        return codezBuiltinContent;
      },
      isSea: () => true,
    },
    appVersion: "test-version",
    platform: "test-platform",
  });

  const codezBuiltinFilePath = prepared[CODEZ_BUILTIN_PROVIDER_CONFIG_FILE_ENV];
  assert.ok(codezBuiltinFilePath);
  assertActiveConfigPath(codezBuiltinFilePath, root);
  assert.deepEqual(
    JSON.parse(await readFile(codezBuiltinFilePath, "utf8")),
    JSON.parse(codezBuiltinContent),
  );
  assert.equal(reads, 1);
  const resource = join(
    root,
    ".codez",
    "v2",
    "runtime",
    "provider",
    "bundled",
    "codez-builtin.json",
  );
  assert.notEqual(resource, codezBuiltinFilePath);
  assert.deepEqual(JSON.parse(await readFile(resource, "utf8")), JSON.parse(codezBuiltinContent));
  assert.equal(prepared.CODEZ_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE, resource);
  await assert.rejects(access(join(dirname(codezBuiltinFilePath), "codez-builtin-refresh.json")));
});

test("does not resolve provider assets for commands that do not run Core", async () => {
  assert.deepEqual(
    await prepareCliProviderRuntimeEnv({
      argv: ["doctor", "--json"],
      env: {},
    }),
    {},
  );
  for (const flag of ["--help", "-h", "--version", "-v"]) {
    assert.deepEqual(
      await prepareCliProviderRuntimeEnv({
        argv: [flag],
        env: {},
      }),
      {},
    );
  }
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codez-cli-provider-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

function assertActiveConfigPath(filePath: string | undefined, dataBaseDir: string): void {
  assert.ok(filePath);
  // 不能用斜杠正则误拒绝 Windows；逐层校验仍包含环境、平台、版本和 Endpoint。
  assert.equal(
    dirname(dirname(filePath)),
    join(dataBaseDir, ".codez", "v2", "runtime", "provider", "test-platform", "test-version"),
  );
  assert.match(basename(dirname(filePath)), /^endpoint-[a-f0-9]{32}$/u);
  assert.equal(basename(filePath), "codez-builtin.json");
}

const EMPTY_RELEASE =
  '{"schemaVersion":1,"revision":1,"config":{"providerConfigRules":{"templateRules":[],"providerRules":[]},"modelConfigRules":{"modelRules":[],"modelApiRules":[],"providerSiteRules":[],"templateModelRules":[],"builtinProviderModelRules":[]}}}';
