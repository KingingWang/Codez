import assert from "node:assert/strict";
import test from "node:test";
import { startDesktopMockProvider } from "./desktop-mock-provider.mjs";

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
