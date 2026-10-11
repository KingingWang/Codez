import assert from "node:assert/strict";
import test from "node:test";
import { startDesktopMockProvider } from "./desktop-mock-provider.mjs";

test("synthetic stream fault remains armed across native retries and explicitly recovers", async () => {
  const provider = await startDesktopMockProvider();
  try {
    await fetch(`${provider.url}/qa/fail-stream`, { method: "POST" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${provider.url}/v1/responses`, {
        method: "POST",
        body: JSON.stringify({ model: "fixture", input: [] }),
      });
      const stream = await response.text();
      assert.equal(response.status, 200);
      assert.match(stream, /response\.created/);
      assert.match(stream, /response\.failed/);
      assert.match(stream, /E2E_CODEX_STREAM_FAILURE/);
      assert.doesNotMatch(stream, /response\.completed/);
    }
    await fetch(`${provider.url}/qa/recover-stream`, { method: "POST" });
    await fetch(`${provider.url}/qa/release`, { method: "POST" });
    const response = await fetch(`${provider.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "fixture", input: [] }),
    });
    assert.match(await response.text(), /response\.completed/);
  } finally {
    provider.close();
  }
});

test("desktop diagnostics inspect developer context without exposing any prompt text", async () => {
  const provider = await startDesktopMockProvider();
  try {
    await fetch(`${provider.url}/qa/release`, { method: "POST" });
    const guidance = "<codez-desktop-context>\nUse $...$ and $$...$$.\n</codez-desktop-context>";
    for (const [role, text] of [
      ["user", guidance],
      ["developer", `Synthetic private instructions.\n${guidance}`],
    ]) {
      const response = await fetch(`${provider.url}/v1/responses`, {
        method: "POST",
        body: JSON.stringify({
          model: "fixture",
          input: [{ role, content: [{ type: "input_text", text }] }],
        }),
      });
      assert.equal(response.status, 200);
      await response.text();
    }
    const diagnostics = await (await fetch(`${provider.url}/qa`)).json();
    assert.deepEqual(
      diagnostics.requests.map(({ desktopContextSections, hasDesktopMathGuidance }) => ({
        desktopContextSections,
        hasDesktopMathGuidance,
      })),
      [
        { desktopContextSections: 0, hasDesktopMathGuidance: false },
        { desktopContextSections: 1, hasDesktopMathGuidance: true },
      ],
    );
    assert.doesNotMatch(JSON.stringify(diagnostics), /Synthetic private|codez-desktop-context/);
  } finally {
    provider.close();
  }
});
