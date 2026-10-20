import assert from "node:assert/strict";
import test from "node:test";
import { normalizeComposerDraftMode } from "./composerDraftModeNormalization.js";

const codexOptions = { codex: true, codexAutoReviewSupported: true };

test("codex legacy build drafts normalize to custom until re-selected", () => {
  // 升级前的存量草稿没有代际标记：旧 build 语义（保留原生权限）等价于新 custom，
  // 直接下发会被 bridge 当成显式迁移而静默改写线程权限。
  assert.equal(normalizeComposerDraftMode({ mode: "build" }, codexOptions), "custom");
  // 新版本显式选择的 build 携带 permissionModeGen:2，原样保留。
  assert.equal(
    normalizeComposerDraftMode({ mode: "build", permissionModeGen: 2 }, codexOptions),
    "build",
  );
  // 其余档位不受代际标记影响。
  assert.equal(normalizeComposerDraftMode({ mode: "yolo" }, codexOptions), "yolo");
  assert.equal(normalizeComposerDraftMode({ mode: "custom" }, codexOptions), "custom");
  assert.equal(normalizeComposerDraftMode({}, codexOptions), undefined);
});

test("codex edit normalizes to custom only while the capability is unconfirmed", () => {
  assert.equal(
    normalizeComposerDraftMode({ mode: "edit" }, { codex: true, codexAutoReviewSupported: false }),
    "custom",
  );
  assert.equal(normalizeComposerDraftMode({ mode: "edit" }, codexOptions), "edit");
});

test("non-codex drafts never carry the codex-only custom mode", () => {
  const options = { codex: false, codexAutoReviewSupported: false };
  // 运行时切换等残留的 custom 草稿回退 build（Codez Agent 运行时没有该档位）。
  assert.equal(normalizeComposerDraftMode({ mode: "custom" }, options), "build");
  // 非 codex 的 build 不做代际归一（旧语义在 Codez Agent 运行时保持不变）。
  assert.equal(normalizeComposerDraftMode({ mode: "build" }, options), "build");
  assert.equal(normalizeComposerDraftMode({ mode: "edit" }, options), "edit");
  assert.equal(normalizeComposerDraftMode({ mode: "yolo" }, options), "yolo");
});
