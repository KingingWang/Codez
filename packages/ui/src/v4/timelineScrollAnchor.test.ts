import assert from "node:assert/strict";
import test from "node:test";
import {
  anchorActionAfterContentChange,
  classifyTimelineScrollSource,
  reconcileFollowingForContentAnchor,
  resolveFollowingAfterScroll,
} from "./timelineScrollAnchor.js";
import { shouldFocusTimelineAfterComposerSend } from "./promptScrollFocusPolicy.js";

test("阅读上文时新轮次、流式内容和布局滚动不能恢复跟随", () => {
  const metrics = { scrollTop: 900, viewportHeight: 600, contentHeight: 1500 };
  assert.equal(
    reconcileFollowingForContentAnchor({
      following: true,
      metrics,
      lastObservedScrollTop: 1000,
      userScrollIntent: "awayFromBottom",
    }),
    false,
  );
  assert.equal(anchorActionAfterContentChange(false), "hold");
  assert.equal(
    resolveFollowingAfterScroll({
      following: false,
      source: "layout",
      metrics,
    }),
    false,
  );
  assert.equal(
    resolveFollowingAfterScroll({
      following: false,
      source: "user",
      metrics,
    }),
    true,
  );
});

test("模型延迟测高触发的未分类 scroll 不按用户回底处理", () => {
  assert.equal(
    classifyTimelineScrollSource({ userScrollIntent: "none", programmaticScroll: false }),
    "layout",
  );
  assert.equal(
    classifyTimelineScrollSource({ userScrollIntent: "unknown", programmaticScroll: false }),
    "user",
  );
  assert.equal(
    classifyTimelineScrollSource({ userScrollIntent: "none", programmaticScroll: true }),
    "programmatic",
  );
});

test("普通后续发送、排队立即发送不强制离底视口跳转；草稿首发仍定位", () => {
  assert.equal(
    shouldFocusTimelineAfterComposerSend({
      draftMode: false,
      inputRoutingMode: "startNow",
    }),
    false,
  );
  assert.equal(
    shouldFocusTimelineAfterComposerSend({
      draftMode: false,
      inputRoutingMode: "enqueue",
      heldQueueDisposition: "keepQueueAndSend",
    }),
    false,
  );
  assert.equal(
    shouldFocusTimelineAfterComposerSend({ draftMode: true, inputRoutingMode: null }),
    true,
  );
});
