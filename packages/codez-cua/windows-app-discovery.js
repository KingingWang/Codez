import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 as windowsPath } from "node:path";

const runCommand = promisify(execFile);

// xa11y 0.15 的 App.list 会对 desktop root 执行 FindAllBuildCache，一个卡住的 UIA
// provider 足以拖垮整次发现。Win32 这里只读取窗口/PID 元数据，UIA 留到选定目标后绑定。
const WINDOWS_APPS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class CodezWindowDiscovery {
  private delegate bool Callback(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll", SetLastError=true)] private static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int capacity);
  public sealed class Window {
    public long window_id;
    public string title;
  }
  public sealed class App {
    public int pid;
    public string name;
    public bool active;
    public List<Window> windows = new List<Window>();
  }
  public static App[] List() {
    var apps = new Dictionary<int, App>();
    uint foregroundPid;
    GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
    bool ok = EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
      if (!IsWindowVisible(hwnd)) return true;
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid == 0 || pid > Int32.MaxValue) return true;
      App app;
      if (!apps.TryGetValue((int)pid, out app)) {
        string name = null;
        try { using (var process = Process.GetProcessById((int)pid)) { name = process.ProcessName; } }
        catch (ArgumentException) { return true; } // 窗口已退出，不是一次发现失败。
        catch (InvalidOperationException) { return true; }
        catch (System.ComponentModel.Win32Exception error) {
          if (error.NativeErrorCode != 5) throw;
        } // 受保护进程可无名称；保留真实 PID，不伪造名称、不触碰其 UIA。
        app = new App { pid = (int)pid, name = name, active = pid == foregroundPid };
        apps.Add((int)pid, app);
      }
      var text = new StringBuilder(4096);
      GetWindowText(hwnd, text, text.Capacity);
      app.windows.Add(new Window { window_id = hwnd.ToInt64(), title = text.ToString() });
      return true;
    }, IntPtr.Zero);
    if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    var result = new App[apps.Count];
    apps.Values.CopyTo(result, 0);
    return result;
  }
}
'@
ConvertTo-Json -InputObject @([CodezWindowDiscovery]::List()) -Depth 5 -Compress
`;

export async function discoverWindowsApps(options = {}) {
  const env = options.env ?? process.env;
  const systemRoot = (env.SystemRoot ?? env.SYSTEMROOT)?.trim();
  if (!systemRoot || !windowsPath.isAbsolute(systemRoot)) {
    throw new Error("Windows system directory is unavailable");
  }
  // 不能从 workspace/cwd 或 PATH 解析同名可执行文件，发现过程只运行系统 PowerShell。
  const executable = windowsPath.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const { stdout } = await (options.run ?? runCommand)(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_APPS_SCRIPT],
    {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    throw new Error("Windows app discovery returned invalid JSON", { cause });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (app) =>
        !Number.isSafeInteger(app?.pid) ||
        app.pid <= 0 ||
        (app.name !== null && (typeof app.name !== "string" || !app.name)) ||
        typeof app.active !== "boolean" ||
        !Array.isArray(app.windows) ||
        app.windows.length === 0 ||
        app.windows.some(
          (window) =>
            !Number.isSafeInteger(window?.window_id) ||
            window.window_id <= 0 ||
            typeof window.title !== "string",
        ),
    )
  ) {
    throw new Error("Windows app discovery returned invalid records");
  }
  return parsed.map((app) => ({ ...app, bundle_id: null }));
}
