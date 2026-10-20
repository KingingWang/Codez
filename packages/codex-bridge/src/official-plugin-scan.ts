/**
 * 插件文本资产的内容扫描：识别指令级的 ZCode 专有运行时耦合（内置浏览器录制、
 * node_repl、computer_use 等）。命中不阻塞安装，只产生可见能力警告——指令级耦合在
 * 运行时自然降级（模型发现工具不存在会如实报告），而工具级耦合必须结构化拦截。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** 内容扫描标记 → 人类可读的耦合能力说明。 */
const ZCODE_RUNTIME_MARKERS: ReadonlyArray<{ marker: RegExp; capability: string }> = [
  { marker: /node_repl/, capability: "ZCode node_repl tool" },
  { marker: /control-browser|BrowserRecordingAPI/, capability: "ZCode built-in browser recording" },
  { marker: /browser_use/, capability: "ZCode Browser Use runtime" },
  { marker: /computer_use/, capability: "ZCode Computer Use runtime" },
];

const SCANNABLE_EXTENSIONS = new Set([
  ".md",
  ".py",
  ".mjs",
  ".js",
  ".cjs",
  ".ts",
  ".json",
  ".yaml",
  ".yml",
  ".txt",
  ".sh",
]);
const SCAN_MAX_FILE_BYTES = 1024 * 1024;
const SCAN_MAX_DEPTH = 6;

export async function scanZcodeRuntimeCoupling(pluginDir: string): Promise<Set<string>> {
  const found = new Set<string>();
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > SCAN_MAX_DEPTH || found.size >= ZCODE_RUNTIME_MARKERS.length) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".git")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (entry.isFile()) {
        const extension = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
        if (!SCANNABLE_EXTENSIONS.has(extension)) continue;
        try {
          const info = await stat(path);
          if (info.size > SCAN_MAX_FILE_BYTES) continue;
          const text = await readFile(path, "utf8");
          for (const { marker, capability } of ZCODE_RUNTIME_MARKERS) {
            if (marker.test(text)) found.add(capability);
          }
        } catch {
          // 单个文件读取失败不阻断扫描。
        }
      }
    }
  }
  await walk(pluginDir, 0);
  return found;
}
