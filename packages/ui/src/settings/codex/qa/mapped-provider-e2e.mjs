import assert from "node:assert/strict";
import { join } from "node:path";

export async function verifyMappedProviderComposer(page, evidence, checks) {
  for (const scenario of ["fresh", "stale"]) {
    await page.goto(`http://127.0.0.1:5188/?mapped-provider=${scenario}`);
    const input = page.getByTestId("mapped-provider-input");
    const send = page.getByRole("button", { name: "Send mapped fixture", exact: true });
    const draft = page.getByTestId("mapped-draft");
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="mapped-draft"]')?.textContent?.includes("model-owner"),
    );
    const expectedModel = scenario === "fresh" ? "glm-5.3" : "second-model";
    const expectedMode = scenario === "fresh" ? "custom" : "yolo";
    const assertDraft = async () => {
      const value = JSON.parse(await draft.innerText());
      assert.deepEqual(value.modelSelection, {
        providerId: "model-owner",
        modelId: expectedModel,
        options: { reasoningLevel: "high" },
      });
      assert.equal(value.mode, expectedMode);
      assert.equal(value.planEnabled, scenario === "stale");
    };
    await assertDraft();
    if (scenario === "fresh") await input.fill("你好");
    else assert.equal(await input.innerText(), "你好");
    await send.click();
    const sent = JSON.parse(await page.getByTestId("mapped-result").innerText());
    assert.equal(sent.text, "你好");
    assert.equal(sent.modelSelection.modelId, expectedModel);
    assert.equal(sent.modelSelection.options.reasoningLevel, "high");
    await page.screenshot({ path: join(evidence, `mapped-provider-${scenario}.png`) });
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="mapped-draft"]')?.textContent?.includes("model-owner"),
    );
    await assertDraft();
    assert.equal(await input.innerText(), "你好");
    await input.press("Enter");
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="mapped-result"]')?.textContent?.includes("你好"),
    );
    assert.equal(await input.innerText(), "你好", "Enter sends without inserting a newline");
    assert.deepEqual(
      JSON.parse(await page.getByTestId("mapped-result").innerText()),
      sent,
      "Button and Enter freeze the same selection after reload",
    );
    await input.press("Shift+Enter");
    assert.match(await input.innerText(), /^你好\n+$/, "Shift+Enter still inserts a newline");
    assert.deepEqual(JSON.parse(await page.getByTestId("mapped-result").innerText()), sent);
    checks.push(
      `${scenario}: mapped provider ready without model toggles; text/high/mode retained across reload; button/Enter send; Shift+Enter newline`,
    );
  }
}
