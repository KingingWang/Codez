import type { ChildProcessWithoutNullStreams } from "node:child_process";

const SHUTDOWN_STAGE_MS = 500;

async function waitForClose(closed: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), SHUTDOWN_STAGE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** EOF lets native Codex flush; escalation is finite even if inherited pipes remain open. */
export async function shutdownCodex(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>,
): Promise<void> {
  child.stdin.end();
  if (await waitForClose(closed)) return;
  child.kill("SIGTERM");
  if (await waitForClose(closed)) return;
  child.kill("SIGKILL");
  if (await waitForClose(closed)) return;
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
}
