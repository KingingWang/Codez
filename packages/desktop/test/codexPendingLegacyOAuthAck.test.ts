import assert from "node:assert/strict";
import test from "node:test";
import { createAppLaunchCoordinator } from "../src/main/appLaunchCoordinator.js";
import { createOAuthCallbackHandler } from "../src/preload/oauthCallbackBridge.js";

test("a transport-only Codex callback acknowledges the old OAuth link to release Main's gate", async () => {
  let consumed = 0;
  const coordinator = createAppLaunchCoordinator({
    consume() {
      consumed++;
      return true;
    },
  });
  const rendererId = 17;
  assert.equal(coordinator.onRendererReady({ hasPendingOAuthCallback: true, rendererId }), false);
  assert.equal(consumed, 0);
  const handler = createOAuthCallbackHandler(
    () => {
      // 夹具模拟原生分支的只回执监听；业务 OAuth 零调用由 UI 夹具单独断言。
    },
    () => {
      assert.equal(coordinator.onOAuthCallbackHandled({ rendererId }), true);
    },
  );
  await handler({}, "codez-codex://oauth/callback?state=isolated-fixture");
  assert.equal(consumed, 1);
  assert.equal(coordinator.onOAuthCallbackHandled({ rendererId }), false);
});
