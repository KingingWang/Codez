import assert from "node:assert/strict";
import test from "node:test";
import { discoverWindowsApps as discoverWindowsAppsImpl } from "./windows-app-discovery.js";

const discoverWindowsApps = (options) =>
  discoverWindowsAppsImpl({ env: { SystemRoot: "C:\\Windows" }, ...options });

test("Windows discovery uses fixed Win32 enumeration, not desktop UIA or user-supplied code", async () => {
  const records = await discoverWindowsApps({
    run: async (file, args, options) => {
      assert.equal(file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 5_000);
      const script = args.at(-1);
      assert.match(script, /EnumWindows/);
      assert.match(script, /GetWindowThreadProcessId/);
      assert.doesNotMatch(script, /UIAutomation|FindAll|Invoke-Expression/);
      return {
        stdout: JSON.stringify([
          {
            pid: 42,
            name: "CalculatorApp",
            active: true,
            windows: [{ window_id: 7, title: "计算器" }],
          },
          {
            pid: 43,
            name: "Notes",
            active: false,
            windows: [{ window_id: 8, title: "Notes" }],
          },
        ]),
      };
    },
  });
  assert.equal(records[0].pid, 42);
  assert.equal(records[0].bundle_id, null);
  assert.equal(records[0].windows[0].title, "计算器");
});

test("Windows discovery cannot resolve its executable through an untrusted cwd or PATH", async () => {
  await assert.rejects(discoverWindowsApps({ env: { PATH: "." } }), /system directory/);
  await assert.rejects(
    discoverWindowsApps({ env: { SystemRoot: "relative" } }),
    /system directory/,
  );
});

test("Windows discovery fails visibly on command failure and malformed output", async () => {
  const failure = new Error("powershell unavailable");
  await assert.rejects(
    discoverWindowsApps({
      run: async () => {
        throw failure;
      },
    }),
    failure,
  );
  for (const stdout of [
    "",
    "null",
    "{}",
    '[{"pid":0}]',
    '[{"pid":42,"name":"Notes","active":true,"windows":[]}]',
  ]) {
    await assert.rejects(discoverWindowsApps({ run: async () => ({ stdout }) }), /invalid/i);
  }
  assert.deepEqual(await discoverWindowsApps({ run: async () => ({ stdout: "[]" }) }), []);
});

test("Windows discovery forwards cancellation without converting it into an empty list", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    discoverWindowsApps({
      signal: controller.signal,
      run: async (_file, _args, options) => {
        assert.equal(options.signal, controller.signal);
        throw controller.signal.reason;
      },
    }),
    { name: "AbortError" },
  );
});
