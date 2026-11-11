import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCmakeGenerators,
  resolveRuntimeHostBuild,
  resolveWindowsCmakeGeneratorCandidates,
  verifyRuntimeHostPe,
} from "../build-windows-runtime-host.mjs";

test("Windows builds both supported architectures with the matching MSVC target", () => {
  assert.deepEqual(resolveRuntimeHostBuild("x64", "win32").configureArgs, [
    "-G",
    "Visual Studio 17 2022",
    "-A",
    "x64",
  ]);
  assert.deepEqual(resolveRuntimeHostBuild("arm64", "win32").configureArgs, [
    "-G",
    "Visual Studio 17 2022",
    "-A",
    "ARM64",
  ]);
  assert.throws(() => resolveRuntimeHostBuild("ia32", "win32"), /architecture/);
});
test("Windows honors an explicitly resolved CMake generator", () => {
  assert.deepEqual(
    resolveRuntimeHostBuild("arm64", "win32", undefined, "Visual Studio 18 2026").configureArgs,
    ["-G", "Visual Studio 18 2026", "-A", "ARM64"],
  );
  // 非 Visual Studio 生成器不接受 -A，只能按宿主架构构建。
  assert.deepEqual(resolveRuntimeHostBuild("x64", "win32", undefined, "Ninja").configureArgs, [
    "-G",
    "Ninja",
  ]);
});
test("CMake generator discovery follows the toolchain installed on the runner", () => {
  const helpText = [
    "Usage: cmake [options] <path-to-source>",
    "",
    "Generators",
    "",
    "The following generators are available on this platform (* marks default):",
    "* Visual Studio 18 2026        = Generates Visual Studio 2026 project files.",
    "                                 Use -A option to specify architecture.",
    "  Visual Studio 17 2022        = Generates Visual Studio 2022 project files.",
    "  Ninja                        = Generates build.ninja files.",
    "  NMake Makefiles              = Generates NMake makefiles.",
    "",
  ].join("\n");
  assert.deepEqual(parseCmakeGenerators(helpText), {
    generators: ["Visual Studio 18 2026", "Visual Studio 17 2022", "Ninja", "NMake Makefiles"],
    defaultGenerator: "Visual Studio 18 2026",
  });
  // runner 升级到 Visual Studio 18 后，探测出的生成器必须排在写死的 17 2022 之前。
  assert.deepEqual(resolveWindowsCmakeGeneratorCandidates({ helpText, env: {} }), [
    "Visual Studio 18 2026",
    "Visual Studio 17 2022",
  ]);
  // `cmake --help` 解析不到内容时仍有兜底候选，不会退化成空列表。
  assert.deepEqual(resolveWindowsCmakeGeneratorCandidates({ helpText: "", env: {} }), [
    "Visual Studio 18 2026",
    "Visual Studio 17 2022",
  ]);
  // 只有非 Visual Studio 默认生成器时才允许它兜底进入候选。
  assert.deepEqual(
    resolveWindowsCmakeGeneratorCandidates({
      helpText: [
        "Generators",
        "* Ninja                        = Generates build.ninja files.",
      ].join("\n"),
      env: {},
    }),
    ["Visual Studio 18 2026", "Visual Studio 17 2022", "Ninja"],
  );
  assert.deepEqual(
    resolveWindowsCmakeGeneratorCandidates({ helpText, env: { CODEZ_CMAKE_GENERATOR: "Ninja" } }),
    ["Ninja"],
  );
});
test("cross builds explicitly select a Windows compiler", () => {
  assert.ok(
    resolveRuntimeHostBuild("x64", "linux").configureArgs.includes("-DCMAKE_SYSTEM_NAME=Windows"),
  );
  assert.ok(
    resolveRuntimeHostBuild("arm64", "linux", "example-clang++").configureArgs.includes(
      "-DCMAKE_CXX_COMPILER=example-clang++",
    ),
  );
});
test("packaging rejects wrong-architecture and corrupt PE binaries", () => {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(0x8664, 68);
  verifyRuntimeHostPe(bytes, "x64");
  assert.throws(() => verifyRuntimeHostPe(bytes, "arm64"), /architecture/);
  assert.throws(() => verifyRuntimeHostPe(Buffer.from("bad"), "x64"), /PE/);
});
