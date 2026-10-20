import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope } from "@codez/shared/codez-protocol-v4";
import { CommandInbox } from "../src/codez-protocol-v4/command-inbox.js";

const send = (
  commandId: string,
  baseRevision?: number,
  baseLogEpoch?: string,
): CommandEnvelope => ({
  commandId,
  clientId: "desktop",
  sessionId: "thread-1",
  issuedAt: 1,
  type: "sendText",
  payload: { text: "Continue from the completed tool results." },
  ...(baseRevision === undefined ? {} : { baseRevision }),
  ...(baseLogEpoch === undefined ? {} : { baseLogEpoch }),
});

test("续做发送校验所见 revision 和 epoch；普通发送保持原有无 CAS 语义", async () => {
  let revision = 3;
  let epoch = "epoch-1";
  const inbox = new CommandInbox({
    getRevision: () => revision,
    getLogEpoch: () => epoch,
  });
  const current = await inbox.handle(send("continue-current", revision, epoch));
  assert.equal(current.kind, "execute");
  if (current.kind === "execute") current.settle({ status: "accepted" });

  revision = 4;
  const staleRevision = await inbox.handle(send("continue-stale-revision", 3, epoch));
  assert.equal(staleRevision.kind, "ack");
  if (staleRevision.kind === "ack") {
    assert.equal(staleRevision.ack.status, "stale");
    assert.equal(staleRevision.ack.reasonCode, "proto.staleRevision");
  }

  epoch = "epoch-2";
  const staleEpoch = await inbox.handle(send("continue-stale-epoch", revision, "epoch-1"));
  assert.equal(staleEpoch.kind, "ack");
  if (staleEpoch.kind === "ack") {
    assert.equal(staleEpoch.ack.status, "stale");
    assert.equal(staleEpoch.ack.reasonCode, "proto.staleLogEpoch");
  }

  const ordinary = await inbox.handle(send("ordinary-send"));
  assert.equal(ordinary.kind, "execute");
  if (ordinary.kind === "execute") ordinary.settle({ status: "accepted" });
});
