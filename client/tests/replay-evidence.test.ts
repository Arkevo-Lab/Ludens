import test from "node:test";
import assert from "node:assert/strict";
import { replayEvidenceParams, replayEvidenceRequestKey } from "../features/replay/replay-evidence-model";

test("direct evidence RPC params preserve scope and distinguish record and event identities", () => {
  const frame = replayEvidenceParams("project=a%26b&run=run&epoch=old&id=event%3A2", {
    kind: "frame",
    record: "capture&1",
    sequence: 0,
  });
  assert.equal(frame.project, "a&b");
  assert.equal(frame.run, "run");
  assert.equal(frame.query.epoch, "old");
  assert.deepEqual(frame.query, { mode: "detail", epoch: "old", record: "capture&1", sequence: 0 });

  const item = replayEvidenceParams("project=a%26b&run=run&epoch=old&record=capture%261&sequence=0", {
    kind: "item",
    id: "event:42",
  });
  assert.equal(item.project, "a&b");
  assert.deepEqual(item.query, { mode: "detail", epoch: "old", id: "event:42" });
  assert.notEqual(
    replayEvidenceRequestKey("project=a&run=r", { kind: "frame", record: "capture&1", sequence: 0 }),
    replayEvidenceRequestKey("project=a&run=r", { kind: "item", id: "event:42" }),
  );
});
