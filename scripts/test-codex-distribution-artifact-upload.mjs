import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

test("installer upload has one same-target retry and never masks final failure", async () => {
  const require = createRequire(new URL("../packages/desktop/package.json", import.meta.url));
  const workflow = require("yaml").parse(
    await readFile(new URL("../.github/workflows/codex-desktop.yml", import.meta.url), "utf8"),
  );
  const { build, release } = workflow.jobs;
  const uploads = build.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(uploads.length, 2, "retry must be bounded to one additional full action attempt");
  const [first, retry] = uploads;
  assert.equal(first.id, "upload_installers");
  assert.equal(first.if, undefined);
  assert.equal(first["continue-on-error"], true);
  assert.equal(retry.if, "${{ steps.upload_installers.outcome == 'failure' }}");
  assert.equal(retry["continue-on-error"], undefined, "a second failure must fail the native job");
  assert.equal(retry.uses, first.uses);
  assert.equal(
    first.with.overwrite,
    undefined,
    "initial upload must not replace an existing artifact",
  );
  assert.equal(retry.with.overwrite, true, "only retry may replace this run's partial artifact");
  const { overwrite: _, ...retryInputs } = retry.with;
  assert.deepEqual(retryInputs, first.with);
  assert.equal(
    first.with.name,
    "codez-${{ matrix.os }}-${{ matrix.arch }}-${{ inputs.signed && matrix.os != 'linux' && 'signed' || 'unsigned' }}",
  );
  assert.equal(first.with["if-no-files-found"], "error");
  assert.equal(first.with["retention-days"], 14);
  assert.ok(first.with.path.includes("packages/desktop/dist/SHA256SUMS-*.txt"));
  assert.ok(first.with.path.includes("packages/desktop/dist/codex-remote-index-*.json"));
  const index = build.steps.indexOf(first);
  assert.equal(build.steps.indexOf(retry), index + 1);
  assert.equal(build.steps[index - 1].run, "node scripts/codex-runtime-artifacts.mjs");
  assert.equal(release.needs, "build");
  assert.doesNotMatch(release.if, /always\(\)|failure\(\)/u);
});
