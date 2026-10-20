import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCodexBridge } from "../../../scripts/build-codex-bridge.mjs";
import { stageCodexRuntime, snapshotCodexBridge } from "../../../scripts/codex-runtime.mjs";

export async function prepareCodexRuntime() {
  const bridgePath = await snapshotCodexBridge({ bridgePath: await buildCodexBridge() });
  const directory = await stageCodexRuntime({ bridgePath });
  console.log(`[codex-runtime] verified resources: ${directory}`);
  return directory;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await prepareCodexRuntime();
