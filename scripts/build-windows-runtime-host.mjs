import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "scripts/windows-runtime-host");

// 上游把 Windows 的 CMake 生成器名写死成 "Visual Studio 17 2022"。GitHub 的
// windows-2025 / windows-11-arm runner 镜像已经升级到 Visual Studio 18 Enterprise，
// 写死名字会让 CMake 直接报 "could not find any instance of Visual Studio"，
// prepare:windows-runtime-host 随之失败并连带整个 Windows 打包 job 失败。
// 这里改成读 CMake 自己报告的生成器列表，按顺序试到第一个能 configure 成功的为止。
const DEFAULT_WINDOWS_CMAKE_GENERATOR = "Visual Studio 17 2022";
const WINDOWS_CMAKE_GENERATOR_FALLBACKS = ["Visual Studio 18 2026", "Visual Studio 17 2022"];

function cmakeCommand() {
  return process.env.CMAKE || "cmake";
}

export function parseCmakeGenerators(helpText) {
  const lines = String(helpText ?? "").split(/\r?\n/);
  // 只在 "Generators" 段之后解析，避免把 Usage/Options 段里带等号的说明误当成生成器。
  const sectionStart = lines.findIndex((line) => line.trim() === "Generators");
  const generators = [];
  let defaultGenerator = null;
  for (const line of sectionStart >= 0 ? lines.slice(sectionStart + 1) : lines) {
    // 形如 "* Visual Studio 18 2026        = Generates Visual Studio 2026 project files."，
    // 行首 "*" 标记当前平台的默认生成器；续行（"Use -A option ..."）没有等号，会被跳过。
    const match = /^\s*(\*)?\s*([^\s=][^=]*?)\s*=(?:\s|$)/.exec(line);
    if (!match) continue;
    const name = match[2].trim();
    if (!name || /\s\s/.test(name)) continue;
    generators.push(name);
    if (match[1] === "*" && defaultGenerator === null) defaultGenerator = name;
  }
  return { generators, defaultGenerator };
}

export function resolveWindowsCmakeGeneratorCandidates({ helpText = "", env = process.env } = {}) {
  // 显式覆盖优先，方便本地固定工具链或在特殊 runner 上绕开探测。
  const override = env.CODEZ_CMAKE_GENERATOR?.trim();
  if (override) return [override];
  const { generators, defaultGenerator } = parseCmakeGenerators(helpText);
  const visualStudio = generators.filter((name) => name.startsWith("Visual Studio"));
  const ordered = [
    // CMake 列出的顺序即"新到旧"，默认生成器一定排在 Visual Studio 段首位。
    ...visualStudio,
    // `cmake --help` 输出格式变化时的兜底，保证候选列表不会退化成空。
    ...WINDOWS_CMAKE_GENERATOR_FALLBACKS,
    // 最后才允许非 Visual Studio 生成器（如 Ninja）：它不支持 -A，只能按宿主架构构建，
    // 产物架构由 verifyRuntimeHostPe 兜底校验。
    ...(defaultGenerator && !defaultGenerator.startsWith("Visual Studio")
      ? [defaultGenerator]
      : []),
  ];
  const candidates = [];
  for (const name of ordered) if (name && !candidates.includes(name)) candidates.push(name);
  return candidates;
}

function readCmakeGeneratorHelp() {
  try {
    const result = spawnSync(cmakeCommand(), ["--help"], { encoding: "utf8" });
    return result.status === 0 ? (result.stdout ?? "") : "";
  } catch {
    return "";
  }
}

function logCmakeToolchain(candidates) {
  // runner 镜像换 Visual Studio 大版本时，这段输出能一次定位是"生成器名不匹配"还是"CMake 太旧"。
  let version = "unknown";
  try {
    version = (spawnSync(cmakeCommand(), ["--version"], { encoding: "utf8" }).stdout ?? "")
      .split(/\r?\n/)[0]
      .trim();
  } catch {
    // 保持 unknown，不阻断构建。
  }
  console.warn(`[runtime-host] ${version}; generator candidates: ${candidates.join(", ")}`);
}

export function resolveRuntimeHostBuild(
  arch,
  hostPlatform = process.platform,
  compiler = process.env.CODEZ_WINDOWS_CXX,
  generator = DEFAULT_WINDOWS_CMAKE_GENERATOR,
) {
  if (arch !== "x64" && arch !== "arm64")
    throw new Error(`Unsupported runtime host architecture: ${arch}`);
  if (hostPlatform !== "win32") {
    return {
      generator: null,
      configureArgs: [
        "-DCMAKE_SYSTEM_NAME=Windows",
        `-DCMAKE_CXX_COMPILER=${compiler || (arch === "arm64" ? "aarch64-w64-mingw32-clang++" : "x86_64-w64-mingw32-g++")}`,
      ],
    };
  }
  return {
    generator,
    // 只有 Visual Studio 生成器接受 -A；其余生成器用宿主默认架构。
    configureArgs: generator.startsWith("Visual Studio")
      ? ["-G", generator, "-A", arch === "arm64" ? "ARM64" : "x64"]
      : ["-G", generator],
  };
}

export function verifyRuntimeHostPe(bytes, arch) {
  const header = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
  if (
    bytes.toString("ascii", 0, 2) !== "MZ" ||
    header < 0 ||
    header + 6 > bytes.length ||
    bytes.toString("ascii", header, header + 4) !== "PE\0\0"
  ) {
    throw new Error("Invalid runtime host PE binary");
  }
  if (bytes.readUInt16LE(header + 4) !== (arch === "arm64" ? 0xaa64 : 0x8664))
    throw new Error("Runtime host architecture mismatch");
}

async function sourceDigest() {
  const hash = createHash("sha256");
  for (const name of ["main.cpp", "installer-process-helper.cpp", "CMakeLists.txt"])
    hash.update(await readFile(join(source, name)));
  return hash.digest("hex");
}

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmakeCommand(), args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolveRun() : reject(new Error(`Runtime host CMake failed: ${code}`)),
    );
  });
}

function resolveBuiltRuntimeHostBinary(work, plan, executable = "codez-runtime-host.exe") {
  // Visual Studio 是多配置生成器，产物落在 Release/ 子目录；Ninja 等单配置生成器直接落在构建根目录。
  const ordered = plan.generator?.startsWith("Visual Studio")
    ? [join(work, "Release", executable), join(work, executable)]
    : [join(work, executable), join(work, "Release", executable)];
  return ordered.find((candidate) => existsSync(candidate)) ?? ordered[0];
}

export async function isRuntimeHostReady(outputDir, arch) {
  try {
    const hostBytes = await readFile(join(outputDir, "codez-runtime-host.exe"));
    const helperBytes = await readFile(join(outputDir, "codez-installer-process-helper.exe"));
    verifyRuntimeHostPe(hostBytes, arch);
    verifyRuntimeHostPe(helperBytes, arch);
    const manifest = JSON.parse(await readFile(join(outputDir, "build.json"), "utf8"));
    return (
      manifest.source === (await sourceDigest()) &&
      manifest.binary === createHash("sha256").update(hostBytes).digest("hex") &&
      manifest.installerProcessHelper === createHash("sha256").update(helperBytes).digest("hex")
    );
  } catch {
    return false;
  }
}

export async function buildRuntimeHost({ arch, outputDir }) {
  const windowsHost = process.platform === "win32";
  let plans;
  if (windowsHost) {
    const candidates = resolveWindowsCmakeGeneratorCandidates({
      helpText: readCmakeGeneratorHelp(),
    });
    logCmakeToolchain(candidates);
    plans = candidates.map((generator) =>
      resolveRuntimeHostBuild(arch, "win32", undefined, generator),
    );
  } else {
    plans = [resolveRuntimeHostBuild(arch)];
  }
  if (plans.length === 0) throw new Error("No usable CMake generator candidate for runtime host");

  let configureFailure = null;
  for (const plan of plans) {
    const work = await mkdtemp(join(tmpdir(), "codez-runtime-host-"));
    try {
      try {
        await run(["-S", source, "-B", work, ...plan.configureArgs, "-DCMAKE_BUILD_TYPE=Release"]);
      } catch (error) {
        // configure 失败基本等于"这套生成器/工具链在本机不可用"，换下一个候选继续试。
        configureFailure = new Error(
          `Runtime host CMake configure failed with generator "${plan.generator}": ${error.message}`,
        );
        console.warn(`[runtime-host] ${configureFailure.message}`);
        continue;
      }
      // configure 已经成功，编译或架构校验失败必须直接抛出，避免用另一套工具链掩盖真实错误。
      // 上游 3.18.1 追加了安装期进程清理 helper，与 runtime host 一次 configure 后同时构建，
      // 保持"configure 成功即锁定工具链"的语义：两个目标都必须编译成功，不单独换生成器重试。
      await run([
        "--build",
        work,
        "--config",
        "Release",
        "--target",
        "codez-runtime-host",
        "codez-installer-process-helper",
      ]);
      const binary = resolveBuiltRuntimeHostBinary(work, plan);
      const helper = resolveBuiltRuntimeHostBinary(
        work,
        plan,
        "codez-installer-process-helper.exe",
      );
      const bytes = await readFile(binary);
      const helperBytes = await readFile(helper);
      verifyRuntimeHostPe(bytes, arch);
      verifyRuntimeHostPe(helperBytes, arch);
      await mkdir(outputDir, { recursive: true });
      await copyFile(binary, join(outputDir, "codez-runtime-host.exe"));
      await copyFile(helper, join(outputDir, "codez-installer-process-helper.exe"));
      await writeFile(
        join(outputDir, "build.json"),
        JSON.stringify({
          source: await sourceDigest(),
          binary: createHash("sha256").update(bytes).digest("hex"),
          installerProcessHelper: createHash("sha256").update(helperBytes).digest("hex"),
        }),
      );
      console.warn(`[runtime-host] built with CMake generator "${plan.generator}"`);
      return;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  throw (
    configureFailure ?? new Error(`Runtime host build found no working CMake generator for ${arch}`)
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const arch =
    args.find((arg) => arg.startsWith("--arch="))?.slice(7) ||
    process.env.CODEZ_TARGET_ARCH ||
    process.arch;
  const outputDir =
    args.find((arg) => arg.startsWith("--output-dir="))?.slice(13) ||
    join(root, "packages/desktop/bundled-tools", `win32-${arch}`, "runtime-host");
  if (!args.includes("--if-windows") || process.platform === "win32") {
    if (!args.includes("--ensure") || !(await isRuntimeHostReady(outputDir, arch))) {
      await buildRuntimeHost({ arch, outputDir });
    }
  }
}
