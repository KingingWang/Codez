import assert from "node:assert/strict";

export async function verifyProjectDiscovery(page, checks) {
  const discoveryAction = async (action) => page.getByTestId(`project-discovery-${action}`).click();
  const discoveryCalls = async () => {
    await discoveryAction("refresh");
    return JSON.parse(await page.getByTestId("project-discovery-result").innerText()).calls;
  };
  let calls = await discoveryCalls();
  assert.deepEqual(calls, [
    { generation: 1, workspacePath: "/remote/project", workspaceIdentity: "remote-a" },
  ]);
  await discoveryAction("focus");
  await discoveryAction("focus");
  assert.equal((await discoveryCalls()).length, 1);
  await discoveryAction("release");
  checks.push(
    "Project activation scans the authorized remote scope; StrictMode and focus coalesce an in-flight scan",
  );

  await discoveryAction("activate-remote-b");
  calls = await discoveryCalls();
  assert.deepEqual(calls.at(-1), {
    generation: 2,
    workspacePath: "/remote/project",
    workspaceIdentity: "remote-b",
  });
  assert.equal(calls.length, 2);
  await discoveryAction("activate-local");
  calls = await discoveryCalls();
  assert.deepEqual(calls.at(-1), { generation: 0, workspacePath: "/local/project" });
  await discoveryAction("activate-remote-a");
  calls = await discoveryCalls();
  assert.deepEqual(calls.at(-1), {
    generation: 1,
    workspacePath: "/remote/project",
    workspaceIdentity: "remote-a",
  });
  assert.equal(calls.length, 4);
  checks.push(
    "Same-path remote projects stay isolated; returning to a warm project rescans external history",
  );

  await discoveryAction("disconnect");
  await discoveryAction("focus");
  await discoveryAction("manual");
  assert.equal(
    (await discoveryCalls()).length,
    4,
    "Disconnected remote discovery must never fall back to local services",
  );
  await discoveryAction("release");
  await discoveryAction("reconnect");
  calls = await discoveryCalls();
  assert.equal(calls.length, 5);
  const reconnected = calls.at(-1);
  assert.ok(reconnected.generation >= 100);
  assert.equal(reconnected.workspaceIdentity, "remote-a");
  await discoveryAction("focus");
  assert.equal((await discoveryCalls()).length, 5);
  await discoveryAction("release");
  await discoveryAction("focus");
  calls = await discoveryCalls();
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.at(-1), reconnected);
  await discoveryAction("release");
  checks.push(
    "Disconnect blocks local fallback; a new remote service generation and subsequent focus each discover fresh history",
  );
  await discoveryAction("metadata");
  assert.equal(
    (await discoveryCalls()).length,
    6,
    "Tab metadata updates must not rescan conversation history",
  );
  await discoveryAction("settings");
  await discoveryAction("focus");
  await discoveryAction("manual");
  assert.equal(
    (await discoveryCalls()).length,
    6,
    "Settings/global scope must not start a project runtime",
  );
  await discoveryAction("activate-remote-a");
  assert.equal((await discoveryCalls()).length, 7);
  await discoveryAction("release");
  checks.push(
    "Conversation/tab metadata does not trigger scans; global settings disables discovery until project reactivation",
  );
}
